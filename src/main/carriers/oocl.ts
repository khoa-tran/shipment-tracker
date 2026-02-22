import { session, WebContentsView } from 'electron';
import * as cheerio from 'cheerio';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cleanText, delay, dumpDebug } from './helpers';
import { getMainWindow } from '../main';

const TIMEOUT = 60000;
const POLL_INTERVAL = 500;

function buildExpressLinkUrl(value: string): string {
  const isContainer = /^[A-Z]{4}\d{7}$/.test(value);
  const blNo = isContainer ? '' : value;
  const contNo = isContainer ? value : '';
  return `https://www.oocl.com/Pages/ExpressLink.aspx?eltype=ct&bl_no=${blNo}&cont_no=${contNo}&booking_no=`;
}

/** Wait until no new did-finish-load fires for `quietMs`, or until `maxWait` elapses. */
function waitForLoadToSettle(view: WebContentsView, maxWait: number, quietMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };
    function done() {
      try {
        view.webContents?.removeListener('did-finish-load', handler);
      } catch { /* view already destroyed */ }
      resolve();
    }
    view.webContents.on('did-finish-load', handler);
    setTimeout(done, maxWait);
  });
}

const CAPTCHA_CHECK = `
  document.body.innerText.includes('slide to verify') ||
  document.body.innerText.includes('Drag the slider') ||
  document.body.innerText.includes('Please slide')
`;

/** Poll until CAPTCHA text disappears (user solved it). */
async function waitForCaptchaDismissed(view: WebContentsView, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (!view.webContents || view.webContents.isDestroyed()) return false;
    const gone = await view.webContents.executeJavaScript(`
      !(${CAPTCHA_CHECK})
    `).catch(() => false);
    if (gone) return true;
    await delay(POLL_INTERVAL);
  }
  return false;
}

/** Poll until page has content (tables or substantial text), indicating results loaded. */
async function waitForContent(view: WebContentsView, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (!view.webContents || view.webContents.isDestroyed()) return false;
    const ready = await view.webContents.executeJavaScript(`
      document.querySelectorAll('table').length >= 1 &&
      document.body.innerText.length > 200
    `).catch(() => false);
    if (ready) return true;
    await delay(POLL_INTERVAL);
  }
  return false;
}

/** Normalize container number: "OOCU904051-4" → "OOCU9040514" */
function normalizeContainerNo(raw: string): string {
  return raw.replace(/-/g, '');
}

function parseResults(html: string, searchValue: string): TrackingResult | null {
  const $ = cheerio.load(html);

  const bodyText = $('body').text();
  if (bodyText.includes('No records were found') || bodyText.includes('no record')) {
    return null;
  }

  const result: TrackingResult = {
    carrier: 'OOCL',
    trackingNo: searchValue,
    trackingUrl: `https://www.oocl.com/Pages/ExpressLink.aspx?eltype=ct&bl_no=${searchValue}&cont_no=&booking_no=`,
    containers: [],
    events: [],
    planMoves: [],
  };

  // === Summary fields ===
  // OOCL uses <td class="labelText"> for labels and next sibling <td> for values
  $('td.labelText').each((_, el) => {
    const labelText = $(el).text().trim();
    const valueEl = $(el).next('td');
    if (!valueEl.length) return;
    const value = cleanText(valueEl.html() || '');
    if (!value) return;

    if (labelText.includes('B/L Vessel Voyage')) result.vesselVoyage = value;
    else if (labelText.includes('Bill of Lading Number')) result.blNo = value.replace(/\s*\(.*?\)\s*/g, '').trim();
    else if (labelText.includes('Booking Number')) result.trackingNo = value.replace(/\s*\(.*?\)\s*/g, '').trim() || searchValue;
    else if (labelText.includes('Total Containers')) result.containerCount = value.match(/^\d+/)?.[0] || value;
  });

  // === Container table (#summaryTable) ===
  // Headers (with rowspan): Container Number | Container Size Type | Quantity | Gross Weight | Verified Gross Mass | Latest Event (Event, Location, Time) | Final Destination
  const summaryTable = $('#summaryTable');
  if (summaryTable.length) {
    // Get all th elements to build column map
    const allTh = summaryTable.find('th');
    const thTexts = allTh.map((__, th) => $(th).text().trim().toLowerCase()).get();

    // Data rows start after the header rows (which use th)
    summaryTable.find('tr').each((__, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;

      // First cell: container number (inside an <a> tag)
      const rawCntr = cleanText($(cells[0]).text());
      const containerNo = normalizeContainerNo(rawCntr);
      if (!/^[A-Z]{4}\d{7,}$/.test(containerNo)) return;

      const cntr: ContainerInfo = {
        containerNo,
        sizeType: cleanText($(cells[1]).text()),
        quantity: cleanText($(cells[2]).text()),
      };

      // Latest Event spans 3 sub-columns after Gross Weight + VGM
      // Cells: [0]CntrNo [1]SizeType [2]Qty [3]GrossWt [4]VGM [5]Event [6]Location [7]Time [8]FinalDest
      if (cells.length >= 8) {
        cntr.currentStatus = cleanText($(cells[5]).text());
        cntr.location = cleanText($(cells[6]).text());
        cntr.date = cleanText($(cells[7]).text());
      }

      result.containers.push(cntr);
    });
  }

  // === Routing table (inside #Tab1 div) ===
  // Headers: Origin | Empty Pickup Location | Full Return Location | Port of Load | Vessel Voyage | Port of Discharge | Final Destination Hub | Destination | Empty Return Location | Haulage
  const routingDiv = $('#Tab1');
  if (routingDiv.length) {
    const routingTable = routingDiv.find('table.dataTable');
    if (routingTable.length) {
      routingTable.find('tr').each((__, row) => {
        const cells = $(row).find('td');
        if (cells.length < 6) return;

        // Map by known column positions from OOCL's fixed layout
        // Origin fields: take from first row only
        if (!result.placeOfReceipt) result.placeOfReceipt = cleanText($(cells[0]).find('span').first().text() || $(cells[0]).text());
        if (!result.portOfLoading) result.portOfLoading = cleanText($(cells[3]).find('span').first().text() || $(cells[3]).text());
        // Destination fields: always overwrite so the last leg (final US port) wins for transshipments
        const pod = cleanText($(cells[5]).find('span').first().text() || $(cells[5]).text());
        if (pod) result.portOfDischarge = pod;
        const vesselVoy = cleanText($(cells[4]).text());
        if (vesselVoy) result.vesselVoyage = vesselVoy;
        if (cells.length >= 8) {
          const delivery = cleanText($(cells[7]).find('span').first().text() || $(cells[7]).text());
          if (delivery) result.placeOfDelivery = delivery;
        }

        // Extract ETA from Port of Discharge cell — always overwrite so last leg wins
        const podCell = $(cells[5]);
        const arrivalSpan = podCell.find('span[id*="actualArrival"], span[id*="estimatedArrivalDate"]').first();
        if (arrivalSpan.length) {
          result.eta = cleanText(arrivalSpan.text());
        }
      });
    }
  }

  // === Equipment Activities table (inside #Tab2 div) ===
  // Headers: Event | Facility | Location | Mode | Time | Remarks
  const activitiesDiv = $('#Tab2');
  if (activitiesDiv.length) {
    const activitiesTable = activitiesDiv.find('table.dataTable');
    if (activitiesTable.length) {
      activitiesTable.find('tr').each((__, row) => {
        const cells = $(row).find('td');
        if (cells.length < 5) return;

        const event = cleanText($(cells[0]).text());
        if (!event) return;

        const ev: TrackingEvent = {
          event,
          location: cleanText($(cells[2]).find('span').first().text() || $(cells[2]).text()),
          date: cleanText($(cells[4]).find('span').first().text() || $(cells[4]).text()),
          terminal: cleanText($(cells[1]).text()),
        };
        result.events.push(ev);
      });
    }
  }

  if (result.containers.length === 0 && result.events.length === 0 && !result.blNo) {
    return null;
  }

  return result;
}

/** Calculate centered bounds for the CAPTCHA view within the main window. */
function getCaptchaBounds(mainWindow: Electron.BrowserWindow): Electron.Rectangle {
  const [winWidth, winHeight] = mainWindow.getContentSize();
  const viewWidth = 500;
  const viewHeight = 600;
  return {
    x: Math.round((winWidth - viewWidth) / 2),
    y: Math.round((winHeight - viewHeight) / 2),
    width: viewWidth,
    height: viewHeight,
  };
}

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

// Serial queue — only one OOCL tracking at a time. This prevents multiple
// CAPTCHAs stacking on top of each other, and the first solve's cookies
// will likely skip CAPTCHA for subsequent requests.
let ooclQueue: Promise<any> = Promise.resolve();

function enqueueOOCL(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const task = ooclQueue.then(() => trackOOCL(searchValue, signal));
  // Keep queue moving even if a task rejects
  ooclQueue = task.catch(() => {});
  return task;
}

async function trackOOCL(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  if (signal?.aborted) return null;

  const url = buildExpressLinkUrl(val);
  const deadline = Date.now() + TIMEOUT;

  const ooclSession = session.fromPartition('persist:oocl');
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log('[OOCL] No main window available');
    return null;
  }

  let view: WebContentsView | null = null;
  let resizeHandler: (() => void) | null = null;

  return new Promise<TrackingResult | null>((resolve) => {
    let resolved = false;

    function finish(result: TrackingResult | null) {
      if (resolved) return;
      resolved = true;
      signal?.removeEventListener('abort', onAbort);

      // Send hide overlay in case it was showing
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('captcha-overlay', false);
        if (resizeHandler) {
          mainWindow.removeListener('resize', resizeHandler);
          resizeHandler = null;
        }
      }

      // Remove and destroy the view
      if (view) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.contentView.removeChildView(view);
          } catch { /* already removed */ }
        }
        try {
          if (!view.webContents?.isDestroyed()) {
            view.webContents.close();
          }
        } catch { /* already destroyed */ }
      }
      view = null;
      resolve(result);
    }

    function onAbort() {
      finish(null);
    }
    signal?.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      console.log('[OOCL] Timeout reached');
      finish(null);
    }, TIMEOUT);

    try {
      view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          session: ooclSession,
        },
      });
    } catch {
      clearTimeout(timer);
      finish(null);
      return;
    }

    // Start hidden (zero-size bounds)
    view.setBounds(HIDDEN_BOUNDS);
    mainWindow.contentView.addChildView(view);

    (async () => {
      try {
        console.log(`[OOCL] Loading: ${url}`);
        await view!.webContents.loadURL(url);

        // Wait for redirect chain to settle (oocl.com → pbservice.moc.oocl.com)
        console.log('[OOCL] Waiting for redirects to settle...');
        await waitForLoadToSettle(view!, 10000);
        if (resolved || !view || !view.webContents || view.webContents.isDestroyed()) return;

        const currentUrl = view.webContents.getURL();
        console.log(`[OOCL] Settled on: ${currentUrl}`);

        // Page loads dynamically via AJAX — poll until CAPTCHA or results appear
        console.log('[OOCL] Waiting for CAPTCHA or content...');
        type PageState = 'captcha' | 'content' | 'no-records' | 'timeout';
        const state = await (async (): Promise<PageState> => {
          while (Date.now() < deadline) {
            if (resolved || !view || !view.webContents || view.webContents.isDestroyed()) return 'timeout';
            const s = await view.webContents.executeJavaScript(`
              (function() {
                var t = document.body.innerText;
                if (t.includes('slide to verify') || t.includes('Drag the slider') || t.includes('Please slide')) return 'captcha';
                if (t.includes('No records were found') || t.includes('no record')) return 'no-records';
                if (document.querySelectorAll('table.dataTable').length > 0 || t.includes('Bill of Lading Number')) return 'content';
                return '';
              })()
            `).catch(() => '');
            if (s) return s as PageState;
            await delay(POLL_INTERVAL);
          }
          return 'timeout';
        })();

        console.log(`[OOCL] Page state: ${state}`);

        if (state === 'no-records' || state === 'timeout') {
          clearTimeout(timer);
          finish(null);
          return;
        }

        if (state === 'captcha') {
          // Show dark overlay in renderer
          mainWindow.webContents.send('captcha-overlay', true);

          // Make the WebContentsView visible and centered
          view!.setBounds(getCaptchaBounds(mainWindow));

          // Hide the view the instant a navigation starts (CAPTCHA solved triggers
          // a redirect). This fires before the new page renders, so user never
          // sees the results page in the overlay.
          let captchaHidden = false;
          const hideOnNavigate = () => {
            if (captchaHidden) return;
            captchaHidden = true;
            console.log('[OOCL] Navigation detected — hiding CAPTCHA view');
            if (view && view.webContents && !view.webContents.isDestroyed()) {
              view.setBounds(HIDDEN_BOUNDS);
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('captcha-overlay', false);
              if (resizeHandler) {
                mainWindow.removeListener('resize', resizeHandler);
                resizeHandler = null;
              }
            }
          };
          view!.webContents.on('will-navigate', hideOnNavigate);
          view!.webContents.on('did-start-navigation', hideOnNavigate);

          // Recenter on window resize
          resizeHandler = () => {
            if (view && view.webContents && !view.webContents.isDestroyed() && !resolved && !captchaHidden) {
              view.setBounds(getCaptchaBounds(mainWindow));
            }
          };
          mainWindow.on('resize', resizeHandler);

          // Wait for CAPTCHA text to disappear (user solved it)
          console.log('[OOCL] Waiting for CAPTCHA to be solved...');
          const dismissed = await waitForCaptchaDismissed(view!, deadline);

          // Ensure hidden (in case no navigation event fired)
          hideOnNavigate();

          if (!dismissed || resolved || !view || !view.webContents || view.webContents.isDestroyed()) {
            console.log('[OOCL] CAPTCHA not solved or aborted');
            clearTimeout(timer);
            finish(null);
            return;
          }

          console.log('[OOCL] CAPTCHA solved, waiting for results page to load...');
          // View is already hidden — wait for content to load invisibly
          await waitForLoadToSettle(view!, 10000);
          await waitForContent(view!, deadline);
        }

        if (resolved || !view || !view.webContents || view.webContents.isDestroyed()) return;

        // Extract HTML
        const html = await view.webContents.executeJavaScript(
          'document.documentElement.outerHTML'
        ).catch(() => '');

        clearTimeout(timer);

        if (!html) {
          console.log('[OOCL] Failed to extract HTML');
          finish(null);
          return;
        }

        // Dump HTML for debugging
        dumpDebug('oocl', 'results', html);

        const result = parseResults(html, val);
        console.log(`[OOCL] Parse result: ${result ? 'found data' : 'null'} (containers=${result?.containers.length}, events=${result?.events.length})`);
        finish(result);
      } catch (err) {
        console.log(`[OOCL] Error: ${err}`);
        clearTimeout(timer);
        finish(null);
      }
    })();
  });
}

registry.register({
  id: 'oocl',
  displayName: 'OOCL',
  track: enqueueOOCL,
});
