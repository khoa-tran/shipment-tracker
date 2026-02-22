import { BrowserWindow, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Dump debug data (HTML or JSON) to the app's debug directory.
 *  Only writes when SHIPMENT_DEBUG=1 env var is set or app is in dev mode. */
export function dumpDebug(carrierId: string, label: string, data: string): void {
  if (!process.env.SHIPMENT_DEBUG && !process.env.npm_lifecycle_event) return;
  try {
    const debugDir = path.join(app.getPath('userData'), 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const filePath = path.join(debugDir, `${carrierId}-${label}-${Date.now()}.json`);
    fs.writeFileSync(filePath, data);
    console.log(`[${carrierId}] Debug saved to: ${filePath}`);
  } catch {
    // ignore
  }
}

export interface CDPTrackOptions {
  /** Carrier identifier for debug logging (e.g. 'msc', 'one') */
  carrierId: string;
  url: string;
  responseUrlMatch: string;
  timeout?: number;
  pageScript: (value: string) => string;
  cookieDismissSelector?: string;
  initialDelay?: number;
  responseValidator?: (json: any) => boolean;
  /** Pre-set cookies before loading the page (e.g. to dismiss consent banners) */
  cookies?: Array<{ url: string; name: string; value: string }>;
  /** Poll for this CSS selector instead of using a fixed initialDelay */
  readySelector?: string;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function cdpTrack(options: CDPTrackOptions, value: string, signal?: AbortSignal): Promise<any> {
  const {
    carrierId,
    url,
    responseUrlMatch,
    timeout = 45000,
    pageScript,
    cookieDismissSelector,
    initialDelay = 3000,
    responseValidator,
    cookies,
    readySelector,
  } = options;

  if (signal?.aborted) return null;

  return new Promise((resolve) => {
    let resolved = false;
    let win: BrowserWindow | null = null;

    function finish(result: any) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      resolve(result);
    }

    const timer = setTimeout(() => finish(null), timeout);

    function onAbort() {
      finish(null);
    }
    signal?.addEventListener('abort', onAbort);

    try {
      win = new BrowserWindow({
        show: false,
        width: 1920,
        height: 1080,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
    } catch {
      finish(null);
      return;
    }

    try {
      win.webContents.debugger.attach('1.3');
    } catch {
      finish(null);
      return;
    }

    win.webContents.debugger.sendCommand('Network.enable').catch(() => {});

    // Buffer matched request IDs; fetch body only after loadingFinished
    const pendingRequests = new Map<string, string>(); // requestId -> url

    win.webContents.debugger.on('message', async (_event, method, params) => {
      if (resolved) return;

      if (method === 'Network.responseReceived') {
        const respUrl = params.response?.url || '';
        const mimeType = params.response?.mimeType || '';
        // Log all XHR/fetch responses for debugging
        if (params.type === 'XHR' || params.type === 'Fetch') {
          console.log(`[${carrierId}] CDP ${params.type}: ${respUrl.substring(0, 150)}`);
        }
        if (responseUrlMatch && !respUrl.includes(responseUrlMatch)) return;
        // Skip JS/CSS assets that happen to match the URL pattern
        if (mimeType.includes('javascript') || mimeType.includes('css') || respUrl.match(/\.(js|css|png|jpg|svg|woff)(\?|$)/)) return;
        console.log(`[${carrierId}] CDP matched response: ${respUrl.substring(0, 120)} (type: ${params.type}, mime: ${mimeType})`);
        pendingRequests.set(params.requestId, respUrl);
        return;
      }

      if (method === 'Network.loadingFinished') {
        const matchedUrl = pendingRequests.get(params.requestId);
        if (!matchedUrl) return;
        pendingRequests.delete(params.requestId);
        console.log(`[${carrierId}] CDP loading finished for: ${matchedUrl.substring(0, 120)}`);
        try {
          const { body } = await win!.webContents.debugger.sendCommand(
            'Network.getResponseBody',
            { requestId: params.requestId }
          );
          console.log(`[${carrierId}] Response body length: ${body.length}`);
          const json = JSON.parse(body);
          if (responseValidator && !responseValidator(json)) return;
          dumpDebug(carrierId, 'response', JSON.stringify(json, null, 2));
          finish(json);
        } catch (e: any) {
          console.log(`[${carrierId}] CDP getResponseBody error: ${e?.message || e}`);
        }
        return;
      }
    });

    win.webContents.on('did-finish-load', async () => {
      try {
        if (resolved) return;
        const pageUrl = win!.webContents.getURL();
        console.log(`[${carrierId}] Page loaded: ${pageUrl.substring(0, 120)}`);

        if (readySelector) {
          // Poll for the target element instead of a fixed delay
          const maxPoll = 10000;
          const interval = 200;
          const start = Date.now();
          while (Date.now() - start < maxPoll && !resolved) {
            const found = await win!.webContents.executeJavaScript(
              `!!document.querySelector('${readySelector}')`
            ).catch(() => false);
            if (found) break;
            await delay(interval);
          }
          // Let the framework finish hydrating after element appears
          await delay(500);
        } else {
          await delay(initialDelay);
        }

        if (resolved) return;
        if (cookieDismissSelector) {
          const clicked = await win!.webContents.executeJavaScript(`
            (function() {
              var btn = document.querySelector('${cookieDismissSelector}');
              if (btn) { btn.click(); return true; }
              return false;
            })();
          `).catch(() => false);
          if (clicked) await delay(1000);
        }

        if (resolved) return;
        console.log(`[${carrierId}] Executing page script...`);
        const scriptResult = await win!.webContents.executeJavaScript(pageScript(value)).catch((e: any) => {
          console.log(`[${carrierId}] Page script error: ${e?.message || e}`);
        });
        console.log(`[${carrierId}] Page script result:`, scriptResult);
      } catch (e: any) {
        console.log(`[${carrierId}] did-finish-load handler error: ${e?.message || e}`);
      }
    });

    win.webContents.on('did-fail-load', (_event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
      console.log(`[${carrierId}] Page failed to load: ${errorCode} ${errorDescription} ${validatedURL}`);
      finish(null);
    });

    // Pre-set cookies before loading (e.g. consent cookies to skip banners)
    const setCookies = async () => {
      if (cookies?.length) {
        for (const cookie of cookies) {
          await win!.webContents.session.cookies.set(cookie).catch(() => {});
        }
      }
    };

    setCookies().then(() => {
      win!.loadURL(url).catch(() => finish(null));
    });
  });
}