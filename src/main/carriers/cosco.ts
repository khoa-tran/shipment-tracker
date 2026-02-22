import { BrowserWindow } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { delay, dumpDebug } from './helpers';

/** Strip common COSCO B/L prefixes so the number works with the Booking No. search. */
function stripBLPrefix(val: string): string {
  return val.replace(/^(COSU|COSCO)/i, '');
}

/** Extract actual date from strings like "Expected：2026-01-11 12:00:00\nActual：2026-01-11 12:37:22".
 *  Prefers the actual date; falls back to expected. Also handles Chinese variants. */
function extractDate(text: string): string {
  // English "Actual:" variant
  const actualEn = text.match(/Actual[：:]\s*([\d-]+\s+[\d:]+)/);
  if (actualEn) return actualEn[1];
  // Chinese "实际:" variant
  const actualCn = text.match(/实际[：:]\s*([\d-]+\s+[\d:]+)/);
  if (actualCn) return actualCn[1];
  // English "Expected:" variant
  const estEn = text.match(/Expected[：:]\s*([\d-]+\s+[\d:]+)/);
  if (estEn) return estEn[1];
  // Chinese "预计:" variant
  const estCn = text.match(/预计[：:]\s*([\d-]+\s+[\d:]+)/);
  if (estCn) return estCn[1];
  // Plain date
  const plainMatch = text.match(/([\d]{4}-[\d]{2}-[\d]{2}\s+[\d:]+)/);
  if (plainMatch) return plainMatch[1];
  return text;
}

async function trackCOSCO(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  const blNumber = stripBLPrefix(val);
  console.log(`[cosco] Starting tracking for: ${val} (search as: ${blNumber})`);

  if (signal?.aborted) return null;

  const TIMEOUT = 45000;

  return new Promise((resolve) => {
    let resolved = false;
    let win: BrowserWindow | null = null;

    function finish(result: TrackingResult | null) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (win && !win.isDestroyed()) win.destroy();
      resolve(result);
    }

    const timer = setTimeout(() => {
      console.log('[cosco] Timeout reached');
      finish(null);
    }, TIMEOUT);

    function onAbort() { finish(null); }
    signal?.addEventListener('abort', onAbort);

    try {
      win = new BrowserWindow({
        show: false,
        width: 1920,
        height: 1080,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
    } catch {
      finish(null);
      return;
    }

    win.webContents.on('did-fail-load', (_e: any, code: any, desc: any, url: any) => {
      console.log(`[cosco] Page failed to load: ${code} ${desc} ${url}`);
      finish(null);
    });

    // Load the SCCT iframe page directly (bypasses parent page iframe issues)
    const pageUrl = 'https://elines.coscoshipping.com/scct/public/ct/base?lang=en';
    console.log(`[cosco] Loading: ${pageUrl}`);
    win.loadURL(pageUrl).catch(() => finish(null));

    win.webContents.on('did-finish-load', async () => {
      try {
        if (resolved) return;
        const loadedUrl = win!.webContents.getURL();
        console.log(`[cosco] Page loaded: ${loadedUrl}`);

        // Wait for the Ant Design input to be ready
        const maxPoll = 15000;
        const interval = 300;
        const start = Date.now();
        while (Date.now() - start < maxPoll && !resolved) {
          const ready = await win!.webContents.executeJavaScript(`
            !!document.querySelector('input.ant-input')
          `).catch(() => false);
          if (ready) break;
          await delay(interval);
        }
        await delay(500);
        if (resolved) return;

        // Enter the tracking number (default dropdown is "Booking No." which works)
        console.log(`[cosco] Entering tracking number: ${blNumber}`);
        const inputResult = await win!.webContents.executeJavaScript(`
          (function() {
            var input = document.querySelector('input.ant-input');
            if (!input) return 'no-input';
            var nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(input, '${blNumber}');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })();
        `).catch((e: any) => { console.log(`[cosco] Input error: ${e?.message}`); return 'error'; });
        console.log(`[cosco] Input result: ${inputResult}`);

        await delay(300);
        if (resolved) return;

        // Click search button using MouseEvent (required for React/Ant Design)
        console.log('[cosco] Clicking search button');
        const btnResult = await win!.webContents.executeJavaScript(`
          (function() {
            var btn = document.querySelector('button.ant-btn');
            if (!btn) return 'no-button';
            var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            btn.dispatchEvent(evt);
            return 'clicked';
          })();
        `).catch((e: any) => { console.log(`[cosco] Button error: ${e?.message}`); return 'error'; });
        console.log(`[cosco] Button result: ${btnResult}`);

        // Wait for SPA navigation to detail or not-found page
        const navStart = Date.now();
        const navTimeout = 20000;
        let detailLoaded = false;
        while (Date.now() - navStart < navTimeout && !resolved) {
          const path = await win!.webContents.executeJavaScript(
            `window.location.pathname`
          ).catch(() => '');

          if (path.includes('detailCT')) {
            detailLoaded = true;
            break;
          }
          if (path.includes('notFoundCT')) {
            console.log('[cosco] Tracking number not found');
            finish(null);
            return;
          }
          await delay(300);
        }

        if (!detailLoaded || resolved) {
          console.log('[cosco] Detail page did not load in time');
          finish(null);
          return;
        }

        // Wait for the detail content to render
        await delay(2000);
        if (resolved) return;

        console.log('[cosco] Scraping tracking data');
        const scraped = await win!.webContents.executeJavaScript(`
          (function() {
            var result = {};
            var allText = document.body.innerText || '';
            result.fullText = allText.substring(0, 5000);

            // Scrape containers table
            result.containers = [];
            var rows = document.querySelectorAll('table tbody tr, .ant-table-tbody tr');
            for (var i = 0; i < rows.length; i++) {
              var cells = rows[i].querySelectorAll('td');
              if (cells.length >= 4) {
                var containerNo = (cells[1]?.textContent || '').trim();
                var transport = (cells[2]?.textContent || '').trim();
                var serviceType = (cells[3]?.textContent || '').trim();
                var location = (cells[4]?.textContent || '').trim();
                var latestMove = (cells[5]?.textContent || '').trim();
                if (containerNo && containerNo.match(/^[A-Z]{4}\\d{7}/)) {
                  result.containers.push({
                    containerNo: containerNo,
                    transport: transport,
                    serviceType: serviceType,
                    location: location,
                    latestMove: latestMove
                  });
                }
              }
            }

            // Scrape vessel/voyage from schedule table
            result.vessels = [];
            var tables = document.querySelectorAll('table, .ant-table');
            var foundVesselTable = false;
            for (var t = 0; t < tables.length && !foundVesselTable; t++) {
              var headerText = tables[t].querySelector('thead')?.textContent || '';
              if (headerText.includes('Vessel') || headerText.includes('Voyage') ||
                  headerText.includes('船名') || headerText.includes('航次')) {
                foundVesselTable = true;
                var vRows = tables[t].querySelectorAll('tbody tr');
                for (var j = 0; j < vRows.length; j++) {
                  var vCells = vRows[j].querySelectorAll('td');
                  if (vCells.length >= 4) {
                    result.vessels.push({
                      vesselName: (vCells[0]?.textContent || '').trim(),
                      voyageRoute: (vCells[1]?.textContent || '').trim(),
                      loadPort: (vCells[2]?.textContent || '').trim(),
                      departTime: (vCells[3]?.textContent || '').trim(),
                      dischargePort: vCells[4] ? (vCells[4]?.textContent || '').trim() : '',
                      arriveTime: vCells[5] ? (vCells[5]?.textContent || '').trim() : ''
                    });
                  }
                }
              }
            }

            // Port info (English labels)
            var polEn = allText.match(/POL\\s*[：:]\\s*([^\\n]+)/i);
            if (polEn) result.portOfLoading = polEn[1].trim();
            var podEn = allText.match(/POD\\s*[：:]\\s*([^\\n]+)/i);
            if (podEn) result.portOfDischarge = podEn[1].trim();
            var porEn = allText.match(/POR\\s*[：:]\\s*([^\\n]+)/i);
            if (porEn) result.placeOfReceipt = porEn[1].trim();
            var fndEn = allText.match(/FND\\s*[：:]\\s*([^\\n]+)/i);
            if (fndEn) result.placeOfDelivery = fndEn[1].trim();

            // Container size from header (e.g. 40RQ*1)
            var sizeMatch = allText.match(/(\\d+[A-Z]{2}\\*\\d+)/);
            if (sizeMatch) result.containerSize = sizeMatch[1];

            // Service mode (CY|CY etc) - English "Traffic Term"
            var modeMatch = allText.match(/Traffic Term[：:]\\s*([A-Z|\\s]+)/i);
            if (modeMatch) result.serviceMode = modeMatch[1].trim();

            // ETA - look for ATA (Actual Time of Arrival) in the milestones
            var ataMatch = allText.match(/ATA\\s+([\\d-]+\\s+[\\d:]+)/);
            if (ataMatch) result.eta = ataMatch[1];

            return result;
          })();
        `).catch((e: any) => {
          console.log(`[cosco] Scrape error: ${e?.message}`);
          return null;
        });

        if (!scraped) {
          finish(null);
          return;
        }

        dumpDebug('cosco', 'scraped', JSON.stringify(scraped, null, 2));
        console.log(`[cosco] Scraped: ${scraped.containers?.length || 0} containers, ${scraped.vessels?.length || 0} vessels`);

        // Build the TrackingResult
        const result: TrackingResult = {
          carrier: 'COSCO',
          trackingNo: val,
          blNo: val,
          containers: [],
          events: [],
          planMoves: [],
        };

        // Port info — strip terminal details after hyphen
        if (scraped.portOfLoading) {
          result.portOfLoading = scraped.portOfLoading.split('-')[0].trim();
        }
        if (scraped.portOfDischarge) {
          result.portOfDischarge = scraped.portOfDischarge.split('-')[0].trim();
        }
        if (scraped.placeOfReceipt) {
          result.placeOfReceipt = scraped.placeOfReceipt.split('-')[0].trim();
        }
        if (scraped.placeOfDelivery) {
          result.placeOfDelivery = scraped.placeOfDelivery.split('-')[0].trim();
        }
        if (scraped.serviceMode) result.serviceMode = scraped.serviceMode;
        if (scraped.eta) result.eta = scraped.eta;

        // Vessel/Voyage from schedule
        if (scraped.vessels?.length > 0) {
          const v = scraped.vessels[0];
          result.vesselVoyage = [v.vesselName, v.voyageRoute].filter(Boolean).join(' / ');
        }

        // Containers
        const containers: ContainerInfo[] = [];
        for (const c of scraped.containers || []) {
          const rawMove = c.latestMove || '';
          const moveDate = rawMove.match(/([\d]{4}-[\d]{2}-[\d]{2}\s+[\d:]+)/)?.[1] || '';
          // Clean move text: extract status text before "At" date
          const moveText = rawMove.replace(/At\s+[\d-]+\s+[\d:]+/, '').trim();
          containers.push({
            containerNo: c.containerNo || '',
            sizeType: scraped.containerSize || '',
            serviceType: c.serviceType || '',
            location: c.location || '',
            latestMove: moveDate ? `${moveText} ${moveDate}` : moveText,
          });
        }
        result.containers = containers;

        // Build events from vessel schedule — clean dates and deduplicate
        const events: TrackingEvent[] = [];
        const seen = new Set<string>();
        for (const v of scraped.vessels || []) {
          const vesselVoyage = [v.vesselName, v.voyageRoute].filter(Boolean).join(' / ');
          if (v.loadPort && v.departTime) {
            const date = extractDate(v.departTime);
            const key = `dep-${v.loadPort}-${date}`;
            if (!seen.has(key)) {
              seen.add(key);
              events.push({ date, location: v.loadPort, event: 'Departure', vesselVoyage });
            }
          }
          if (v.dischargePort && v.arriveTime) {
            const date = extractDate(v.arriveTime);
            const key = `arr-${v.dischargePort}-${date}`;
            if (!seen.has(key)) {
              seen.add(key);
              events.push({ date, location: v.dischargePort, event: 'Arrival', vesselVoyage });
            }
          }
        }
        result.events = events;

        if (containers.length === 0 && events.length === 0 && !result.eta) {
          finish(null);
          return;
        }

        finish(result);
      } catch (e: any) {
        console.log(`[cosco] Error in page handler: ${e?.message || e}`);
        finish(null);
      }
    });
  });
}

console.log('[cosco] Registering COSCO carrier');
registry.register({
  id: 'cosco',
  displayName: 'COSCO',
  track: trackCOSCO,
});
