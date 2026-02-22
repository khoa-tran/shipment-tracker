import { BrowserWindow } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { delay, dumpDebug } from './helpers';

const API_BASE = 'https://api.ekmtc.com/trans/trans/cargo-tracking';

// --- API response types ---

interface KmtcContainerEntry {
  blNo?: string;
  bkgNo?: string;
  cntrNo?: string;
  cntrSzCd?: string;
  cntrTypCd?: string;
  polPortNm?: string;
  podPortNm?: string;
  vslNm?: string;
  voyNo?: string;
  etd?: string;
  eta?: string;
  orgPolPortNm?: string;
  orgPodPortNm?: string;
  issueStatus?: string;
}

interface KmtcSearchResponse {
  cntrList?: KmtcContainerEntry[];
}

interface KmtcTrackingEvent {
  blNo?: string;
  mvntDt?: string;
  mvntTm?: string;
  plcNm?: string;
  trmlNm?: string;
  cntrStsCd?: string;
  cntrMvntCd?: string;
  feCatCd?: string;
  rk?: string;
  ctrCd?: string;
  plcCd?: string;
}

interface KmtcDetailResponse {
  trackingList?: KmtcTrackingEvent[];
}

// --- Helpers ---

function formatDate(dateStr: string): string {
  if (!dateStr || dateStr.length < 8) return dateStr || '';
  // Input: "202601240548" (yyyyMMddHHmm) or "20260124" (yyyyMMdd)
  const y = dateStr.substring(0, 4);
  const m = dateStr.substring(4, 6);
  const d = dateStr.substring(6, 8);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = parseInt(m, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return dateStr;
  return `${d}-${months[monthIdx]}-${y}`;
}

function formatDateTime(datePart: string, timePart: string): string {
  const dateFormatted = formatDate(datePart);
  if (!timePart || timePart.length < 4) return dateFormatted;
  const hh = timePart.substring(0, 2);
  const mm = timePart.substring(2, 4);
  return `${dateFormatted} ${hh}:${mm}`;
}

/** Ensure commas are followed by a space (e.g. "QINGDAO,CHINA" → "QINGDAO, CHINA") */
function normalizeCommas(text: string): string {
  return text.replace(/,(?!\s)/g, ', ').trim();
}

/** Map KMTC status codes to human-readable event descriptions */
function describeEvent(stsCd: string, mvntCd: string): string {
  const sts: Record<string, string> = {
    GTI: 'Gate In',
    GTO: 'Gate Out',
    LDG: 'Loading',
    DIS: 'Discharging',
    RDL: 'Rail Departure',
    RAL: 'Rail Arrival',
    TRS: 'Transshipment',
  };
  const dir: Record<string, string> = {
    OB: 'Outbound',
    IB: 'Inbound',
  };
  const stsText = sts[stsCd] || stsCd || '';
  const dirText = dir[mvntCd] || mvntCd || '';
  return [stsText, dirText].filter(Boolean).join(' ');
}

// --- Main tracking function ---

async function trackKMTC(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  console.log(`[kmtc] Tracking: ${val}`);

  if (signal?.aborted) return null;

  let win: BrowserWindow | null = null;
  let resolved = false;

  function cleanup() {
    resolved = true;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    win = null;
  }

  try {
    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    const abortHandler = () => cleanup();
    signal?.addEventListener('abort', abortHandler);

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        console.log('[kmtc] Timeout reached');
        cleanup();
      }
    }, 45000);

    // Load the eKMTC page to get Akamai cookies
    try {
      await win.loadURL('https://www.ekmtc.com/index.html#/cargo-tracking');
    } catch {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    if (resolved) return null;

    // Check for Akamai challenge page
    const pageTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
    console.log(`[kmtc] Page title: ${pageTitle}`);

    if (pageTitle === 'Challenge Validation') {
      win.show();
      console.log('[kmtc] Challenge detected, showing window for auto-resolution...');

      const challengeStart = Date.now();
      const challengeTimeout = 20000;
      while (Date.now() - challengeStart < challengeTimeout && !resolved) {
        await delay(1000);
        const currentTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
        if (currentTitle && currentTitle !== 'Challenge Validation') {
          console.log(`[kmtc] Challenge resolved: ${currentTitle}`);
          win.hide();
          await delay(1000);
          break;
        }
      }

      const finalTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
      if (finalTitle === 'Challenge Validation') {
        console.log('[kmtc] Challenge not resolved within timeout');
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);
        cleanup();
        return null;
      }
    }

    if (resolved) return null;

    // Wait for page to settle
    await delay(2000);

    // Step 1: Search — get container list via API from page context
    console.log('[kmtc] Calling search API via page context...');
    const searchJson = await win.webContents.executeJavaScript(`
      fetch('${API_BASE}/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ dtKnd: 'BL', blNo: '${val}' })
      })
      .then(function(r) { return r.text(); })
      .catch(function(e) { return JSON.stringify({ error: e.message }); })
    `).catch(() => null);

    if (!searchJson || resolved) {
      console.log('[kmtc] No response from search API');
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    let searchData: KmtcSearchResponse;
    try {
      searchData = JSON.parse(searchJson);
    } catch {
      console.log('[kmtc] Failed to parse search response');
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    if ((searchData as any).error) {
      console.log(`[kmtc] Search API error: ${(searchData as any).error}`);
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    dumpDebug('kmtc', 'search', JSON.stringify(searchData, null, 2));

    if (!searchData.cntrList || searchData.cntrList.length === 0) {
      console.log('[kmtc] No containers found');
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    const first = searchData.cntrList[0];
    const blNo = first.blNo || val;
    const bkgNo = first.bkgNo || '';

    const result: TrackingResult = {
      carrier: 'KMTC',
      trackingNo: val,
      blNo: blNo,
      vesselVoyage: first.vslNm || undefined,
      eta: first.eta ? formatDate(first.eta) : undefined,
      portOfLoading: normalizeCommas(first.orgPolPortNm || first.polPortNm || '') || undefined,
      portOfDischarge: normalizeCommas(first.orgPodPortNm || first.podPortNm || '') || undefined,
      trackingUrl: 'https://www.ekmtc.com/index.html#/cargo-tracking',
      containers: [],
      events: [],
      planMoves: [],
    };

    // Build unique containers from search results
    const seenContainers = new Set<string>();
    for (const entry of searchData.cntrList) {
      const cntrNo = entry.cntrNo || '';
      if (!cntrNo || seenContainers.has(cntrNo)) continue;
      seenContainers.add(cntrNo);
      result.containers.push({
        containerNo: cntrNo,
        sizeType: `${entry.cntrSzCd || ''} ${entry.cntrTypCd || ''}`.trim(),
      });
    }

    if (resolved) {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      return null;
    }

    // Step 2: Get detail/events for first container
    const firstCntrNo = result.containers[0]?.containerNo || '';
    if (firstCntrNo && bkgNo) {
      console.log(`[kmtc] Fetching detail for ${blNo}, container ${firstCntrNo}...`);
      const detailUrl = `${API_BASE}/${encodeURIComponent(blNo)}/detail?bkgNo=${encodeURIComponent(bkgNo)}&cntrNo=${encodeURIComponent(firstCntrNo)}&dtKnd=BL&strBkgNo=${encodeURIComponent(bkgNo)}`;

      const detailJson = await win.webContents.executeJavaScript(`
        fetch('${detailUrl}', {
          headers: { 'Accept': 'application/json' }
        })
        .then(function(r) { return r.text(); })
        .catch(function(e) { return JSON.stringify({ error: e.message }); })
      `).catch(() => null);

      if (detailJson && !resolved) {
        try {
          const detailData: KmtcDetailResponse = JSON.parse(detailJson);
          dumpDebug('kmtc', 'detail', JSON.stringify(detailData, null, 2));

          if (detailData.trackingList) {
            for (const ev of detailData.trackingList) {
              result.events.push({
                date: formatDateTime(ev.mvntDt || '', ev.mvntTm || ''),
                location: ev.plcNm || '',
                event: describeEvent(ev.cntrStsCd || '', ev.cntrMvntCd || ''),
                terminal: ev.trmlNm || undefined,
                containerNo: firstCntrNo,
              });
            }
          }
        } catch {
          console.log('[kmtc] Failed to parse detail response');
        }
      }
    }

    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortHandler);
    cleanup();

    if (result.containers.length === 0 && result.events.length === 0 && !result.eta) return null;

    return result;
  } catch (err) {
    console.error('[kmtc] Error:', err);
    cleanup();
    return null;
  }
}

registry.register({
  id: 'kmtc',
  displayName: 'KMTC',
  track: trackKMTC,
});
