import { BrowserWindow } from 'electron';

export interface CDPTrackOptions {
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

    win.webContents.debugger.on('message', async (_event, method, params) => {
      if (resolved) return;
      if (method !== 'Network.responseReceived') return;
      if (responseUrlMatch && !params.response?.url?.includes(responseUrlMatch)) return;
      try {
        const { body } = await win!.webContents.debugger.sendCommand(
          'Network.getResponseBody',
          { requestId: params.requestId }
        );
        const json = JSON.parse(body);
        if (responseValidator && !responseValidator(json)) return;
        finish(json);
      } catch {
        // Window destroyed or body not ready — ignore
      }
    });

    win.webContents.on('did-finish-load', async () => {
      try {
        if (resolved) return;

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
        await win!.webContents.executeJavaScript(pageScript(value)).catch(() => {});
      } catch {
        // Window destroyed during page interaction — ignore
      }
    });

    win.webContents.on('did-fail-load', () => {
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