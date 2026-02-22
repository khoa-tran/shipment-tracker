import { BrowserWindow } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { delay, dumpDebug } from './helpers';

async function trackCMACGM(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  console.log(`[cmacgm] Starting tracking for: ${val}`);

  if (signal?.aborted) return null;

  const TIMEOUT = 50000;

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
      console.log('[cmacgm] Timeout reached');
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
      console.log(`[cmacgm] did-fail-load: ${code} ${desc} ${url}`);
      finish(null);
    });

    win.webContents.on('will-navigate', (_event: any, url: string) => {
      console.log(`[cmacgm] will-navigate: ${url}`);
    });

    const pageUrl = 'https://www.cma-cgm.com/ebusiness/tracking';
    console.log(`[cmacgm] Loading: ${pageUrl}`);
    win.loadURL(pageUrl).catch(() => finish(null));

    win.webContents.on('did-finish-load', async () => {
      try {
        if (resolved) return;
        const loadedUrl = win!.webContents.getURL();
        console.log(`[cmacgm] Page loaded: ${loadedUrl}`);

        if (loadedUrl.includes('/tracking/search')) return;

        // Wait for the search input to be ready
        console.log('[cmacgm] Waiting for search input...');
        const maxPoll = 15000;
        const interval = 300;
        const start = Date.now();
        let inputFound = false;
        while (Date.now() - start < maxPoll && !resolved) {
          const ready = await win!.webContents.executeJavaScript(`
            !!document.querySelector('input[name="SearchViewModel.Reference"]')
          `).catch(() => false);
          if (ready) { inputFound = true; break; }
          await delay(interval);
        }
        console.log(`[cmacgm] Search input ${inputFound ? 'found' : 'NOT found'} after ${Date.now() - start}ms`);
        await delay(500);
        if (resolved) return;

        // Dismiss cookie banner if present
        const cookieResult = await win!.webContents.executeJavaScript(`
          (function() {
            var btn = document.querySelector('#onetrust-accept-btn-handler');
            if (btn) { btn.click(); return 'dismissed'; }
            return 'no-banner';
          })();
        `).catch(() => 'error');
        console.log(`[cmacgm] Cookie banner: ${cookieResult}`);
        await delay(500);
        if (resolved) return;

        console.log(`[cmacgm] Entering tracking number: ${val}`);
        const inputResult = await win!.webContents.executeJavaScript(`
          (function() {
            var input = document.querySelector('input[name="SearchViewModel.Reference"]');
            if (!input) return 'no-input';
            var nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(input, '${val}');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })();
        `).catch((e: any) => { console.log(`[cmacgm] Input error: ${e?.message}`); return 'error'; });
        console.log(`[cmacgm] Input result: ${inputResult}`);
        if (inputResult !== 'ok') { finish(null); return; }

        await delay(300);
        if (resolved) return;

        // Submit the form
        console.log('[cmacgm] Submitting search form');
        const submitResult = await win!.webContents.executeJavaScript(`
          (function() {
            var form = document.querySelector('form[action*="tracking/search"][method="post"]');
            if (!form) return 'no-form';
            var inputs = form.querySelectorAll('input');
            var fields = [];
            for (var i = 0; i < inputs.length; i++) {
              fields.push(inputs[i].name + '=' + inputs[i].value.substring(0, 30));
            }
            form.submit();
            return 'submitted: ' + fields.join(', ');
          })();
        `).catch((e: any) => { console.log(`[cmacgm] Submit error: ${e?.message}`); return 'error'; });
        console.log(`[cmacgm] Form submit: ${submitResult}`);

      } catch (e: any) {
        console.log(`[cmacgm] Error in initial load handler: ${e?.message || e}`);
      }
    });

    // Listen for the results page to finish loading
    win.webContents.on('did-navigate', async (_event: any, url: string) => {
      try {
        if (resolved) return;
        console.log(`[cmacgm] Navigated to: ${url}`);

        if (!url.includes('/tracking/search')) return;

        // Wait for tracking results to render
        const maxPoll = 15000;
        const interval = 300;
        const start = Date.now();
        let hasResults = false;
        while (Date.now() - start < maxPoll && !resolved) {
          hasResults = await win!.webContents.executeJavaScript(`
            !!document.querySelector('.tracking-details') || !!document.querySelector('.tracking-detail-container-reference')
          `).catch(() => false);
          if (hasResults) break;
          await delay(interval);
        }

        if (!hasResults || resolved) {
          const pageTitle = await win!.webContents.executeJavaScript(`document.title`).catch(() => '');
          const bodySnippet = await win!.webContents.executeJavaScript(
            `document.body.innerText.substring(0, 500)`
          ).catch(() => '');
          console.log(`[cmacgm] No tracking results found. Title: ${pageTitle}`);
          console.log(`[cmacgm] Page snippet: ${bodySnippet?.substring(0, 300)}`);
          finish(null);
          return;
        }

        console.log('[cmacgm] Tracking results detected, waiting for render...');
        await delay(1000);
        if (resolved) return;

        // Expand "Display Previous Moves" to show all events
        const expandResult = await win!.webContents.executeJavaScript(`
          (function() {
            var btns = document.querySelectorAll('a, button, [role="button"]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].textContent && btns[i].textContent.indexOf('Display Previous') !== -1) {
                btns[i].click();
                return 'expanded';
              }
            }
            return 'no-button';
          })();
        `).catch(() => 'error');
        console.log(`[cmacgm] Expand previous moves: ${expandResult}`);
        await delay(500);
        if (resolved) return;

        // Scrape all tracking data from the DOM
        console.log('[cmacgm] Scraping tracking data');
        const scraped = await win!.webContents.executeJavaScript(`
          (function() {
            var result = {};

            var containerRef = document.querySelector('.tracking-detail-container-reference');
            result.containerNo = containerRef ? containerRef.textContent.trim() : '';
            if (!result.containerNo) {
              var resumeFilter = document.querySelector('.resume-filter');
              if (resumeFilter) {
                var strong = resumeFilter.querySelector('strong');
                if (strong) result.containerNo = strong.textContent.trim();
              }
            }

            var sizeType = document.querySelector('.tracking-detail-container-sizetype');
            result.sizeType = sizeType ? sizeType.textContent.trim() : '';
            if (!result.sizeType) {
              var match = document.body.innerText.match(/(\\d{2}[A-Z]\\d)\\s*\\(([^)]+)\\)/);
              if (match) result.sizeType = match[1];
            }

            var timelineItems = document.querySelectorAll('.timeline--item');
            result.pol = '';
            result.pod = '';
            result.fpd = '';
            result.eta = '';
            for (var i = 0; i < timelineItems.length; i++) {
              var desc = timelineItems[i].querySelector('.timeline--item-description');
              var etaEl = timelineItems[i].querySelector('.timeline--item-eta');
              var text = desc ? desc.textContent.trim() : '';
              if (text.indexOf('POL') !== -1) {
                result.pol = text.replace(/POL\\s*/, '').trim();
              } else if (text.indexOf('POD') !== -1) {
                result.pod = text.replace(/POD\\s*/, '').trim();
                if (etaEl) {
                  var etaText = etaEl.textContent.trim();
                  var etaMatch = etaText.match(/([A-Z][a-z]{2})\\s+(\\d{1,2}-[A-Z]{3}-\\d{4})\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)/);
                  if (etaMatch) result.eta = etaMatch[2] + ' ' + etaMatch[3];
                }
              } else if (text.indexOf('FPD') !== -1) {
                result.fpd = text.replace(/FPD\\s*/, '').trim();
              }
            }

            var detailItems = document.querySelectorAll('.detail-item, .info-Details');
            for (var j = 0; j < detailItems.length; j++) {
              var dtText = detailItems[j].textContent.trim();
              if (dtText.indexOf('Booking reference') !== -1) {
                result.bookingRef = dtText.replace(/Booking reference\\s*/, '').trim();
              } else if (dtText.indexOf('Bill of lading') !== -1) {
                result.blNo = dtText.replace(/Bill of lading\\s*/, '').trim();
              }
            }

            var vesselCells = document.querySelectorAll('td.vesselVoyage');
            for (var v = 0; v < vesselCells.length; v++) {
              var vText = vesselCells[v].textContent.trim()
                .replace(/Accessible text[\\s\\S]*/g, '').trim();
              if (vText) {
                result.vesselVoyage = vText;
                break;
              }
            }

            result.events = [];
            var detailRows = document.querySelectorAll('.k-detail-cell table tr, .k-grid-content table tr');
            for (var r = 0; r < detailRows.length; r++) {
              var tds = detailRows[r].querySelectorAll('td');
              var dateTd = detailRows[r].querySelector('td.date');
              if (!dateTd || !dateTd.textContent.trim()) continue;

              var dateText = dateTd.textContent.trim();
              var dateIdx = -1;
              for (var c = 0; c < tds.length; c++) {
                if (tds[c] === dateTd) { dateIdx = c; break; }
              }
              if (dateIdx < 0) continue;

              var moveText = (dateIdx + 1 < tds.length) ? tds[dateIdx + 1].textContent.trim() : '';
              var locCell = detailRows[r].querySelector('td.location');
              var locText = '';
              if (locCell) {
                var bubble = locCell.querySelector('.js-bubble');
                if (bubble) {
                  var firstSpan = bubble.querySelector('span:not(.u-hiddentext)');
                  locText = firstSpan ? firstSpan.textContent.trim() : '';
                } else {
                  locText = locCell.textContent.trim().replace(/Accessible text[\\s\\S]*/g, '').trim();
                }
              }
              var vesselCell = detailRows[r].querySelector('td.vesselVoyage');
              var vesselText = '';
              if (vesselCell) {
                vesselText = vesselCell.textContent.trim()
                  .replace(/Accessible text[\\s\\S]*/g, '').trim();
              }

              result.events.push({
                date: dateText,
                move: moveText,
                location: locText,
                vessel: vesselText
              });
            }

            return result;
          })();
        `).catch((e: any) => {
          console.log(`[cmacgm] Scrape error: ${e?.message}`);
          return null;
        });

        if (!scraped) {
          finish(null);
          return;
        }

        dumpDebug('cmacgm', 'scraped', JSON.stringify(scraped, null, 2));
        console.log(`[cmacgm] Scraped: container=${scraped.containerNo}, events=${scraped.events?.length || 0}`);

        // Build TrackingResult
        const result: TrackingResult = {
          carrier: 'CMA CGM',
          trackingNo: val,
          trackingUrl: 'https://www.cma-cgm.com/ebusiness/tracking',
          containers: [],
          events: [],
          planMoves: [],
        };

        if (scraped.blNo) result.blNo = scraped.blNo;
        if (scraped.pol) result.portOfLoading = scraped.pol;
        if (scraped.pod) result.portOfDischarge = scraped.pod;
        if (scraped.fpd) result.placeOfDelivery = scraped.fpd;
        if (scraped.eta) result.eta = scraped.eta;
        if (scraped.vesselVoyage) result.vesselVoyage = scraped.vesselVoyage;

        // Container
        if (scraped.containerNo) {
          const containers: ContainerInfo[] = [{
            containerNo: scraped.containerNo,
            sizeType: scraped.sizeType || '',
            latestMove: scraped.events?.length > 0
              ? scraped.events[scraped.events.length - 1].move
              : '',
          }];
          result.containers = containers;
        }

        // Events
        const events: TrackingEvent[] = [];
        for (const e of scraped.events || []) {
          events.push({
            date: e.date || '',
            location: e.location || '',
            event: e.move || '',
            vesselVoyage: e.vessel || '',
          });
        }
        result.events = events;

        if (result.containers.length === 0 && result.events.length === 0 && !result.eta) {
          console.log('[cmacgm] No usable data extracted, returning null');
          finish(null);
          return;
        }

        console.log(`[cmacgm] Success: ${result.containers.length} containers, ${result.events.length} events, eta=${result.eta}, pol=${result.portOfLoading}, pod=${result.portOfDischarge}`);
        finish(result);
      } catch (e: any) {
        console.log(`[cmacgm] Error in results handler: ${e?.message || e}`);
        finish(null);
      }
    });
  });
}

registry.register({
  id: 'cmacgm',
  displayName: 'CMA CGM',
  track: trackCMACGM,
});
