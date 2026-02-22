import { BrowserWindow } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { delay, dumpDebug } from './helpers';

const API_BASE = 'https://apigw.zim.com/digital/TrackShipment/v1';
const API_KEY = '9d63cf020a4c4708a7b0ebfe39578300';

interface ZimActivity {
  activityDateTz?: string;
  activityDesc?: string;
  countryFromName?: string;
  placeFromDesc?: string;
  vesselName?: string;
  voyage?: string;
  leg?: string;
}

interface ZimContainerEntry {
  unitPrefix?: string;
  unitNo?: string;
  cargoType?: string;
  unitActivityList?: ZimActivity[];
}

interface ZimRouteLeg {
  portNameFrom?: string;
  portNameTo?: string;
  countryNameFrom?: string;
  countryNameTo?: string;
  portFromType?: string;
  portToType?: string;
  vesselName?: string;
  voyage?: string;
  leg?: string;
  sailingDateTz?: string;
  arrivalDateTz?: string;
  depotNameFrom?: string;
  depotNameTo?: string;
}

interface ZimApiResponse {
  data?: {
    blRouteLegs?: ZimRouteLeg[];
    consignmentDetails?: {
      consContainerList?: ZimContainerEntry[];
      consPodDesc?: string;
      consPodCountryName?: string;
      consPolDesc?: string;
      consPolCountryName?: string;
      [key: string]: any;
    };
    finalETA?: { etaValue?: string };
    agreedETA?: { etaValue?: string };
    [key: string]: any;
  };
  isSuccess?: boolean;
  [key: string]: any;
}

async function trackZIM(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

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
    // Create a visible window so Akamai bot challenge can auto-resolve
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
        console.log('[zim] Timeout reached');
        cleanup();
      }
    }, 45000);

    // Load the ZIM page to get Akamai cookies
    try {
      await win.loadURL('https://www.zim.com/tools/track-a-shipment');
    } catch {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortHandler);
      cleanup();
      return null;
    }

    if (resolved) return null;

    // Check if we hit a challenge page
    const pageTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
    console.log(`[zim] Page title: ${pageTitle}`);

    if (pageTitle === 'Challenge Validation') {
      // Show the window so the challenge can run in a visible context
      win.show();
      console.log('[zim] Challenge detected, showing window for auto-resolution...');

      const challengeStart = Date.now();
      const challengeTimeout = 20000;
      while (Date.now() - challengeStart < challengeTimeout && !resolved) {
        await delay(1000);
        const currentTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
        if (currentTitle && currentTitle !== 'Challenge Validation') {
          console.log(`[zim] Challenge resolved: ${currentTitle}`);
          win.hide();
          await delay(1000);
          break;
        }
      }

      const finalTitle = await win.webContents.executeJavaScript('document.title').catch(() => '');
      if (finalTitle === 'Challenge Validation') {
        console.log('[zim] Challenge not resolved within timeout');
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortHandler);
        cleanup();
        return null;
      }
    }

    if (resolved) return null;

    // Call the API from within the page context (has correct origin + Akamai cookies)
    const apiUrl = `${API_BASE}/${encodeURIComponent(val)}/result?subscription-key=${API_KEY}`;
    console.log(`[zim] Calling API via page context...`);

    const jsonStr = await win.webContents.executeJavaScript(`
      fetch('${apiUrl}', {
        headers: { 'Accept': 'application/json, text/plain, */*' }
      })
      .then(function(r) { return r.text(); })
      .catch(function(e) { return JSON.stringify({ error: e.message }); })
    `).catch(() => null);

    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortHandler);

    if (!jsonStr) {
      console.log('[zim] No response from API');
      cleanup();
      return null;
    }

    let json: ZimApiResponse;
    try {
      json = JSON.parse(jsonStr);
    } catch {
      console.log('[zim] Failed to parse API response');
      cleanup();
      return null;
    }

    if ((json as any).error) {
      console.log(`[zim] API error: ${(json as any).error}`);
      cleanup();
      return null;
    }
    dumpDebug('zim', 'response', JSON.stringify(json, null, 2));
    cleanup();

    if (!json?.data) return null;

    const data = json.data;
    const consignment = data.consignmentDetails;

    // Build TrackingResult
    const result: TrackingResult = {
      carrier: 'ZIM',
      trackingNo: val,
      containers: [],
      events: [],
      planMoves: [],
    };

    // ETA
    if (data.finalETA?.etaValue) {
      result.eta = formatDate(data.finalETA.etaValue);
    } else if (data.agreedETA?.etaValue) {
      result.eta = formatDate(data.agreedETA.etaValue);
    }

    // POL / POD from consignment details
    if (consignment) {
      result.portOfLoading = [consignment.consPolDesc, consignment.consPolCountryName].filter(Boolean).join(', ');
      result.portOfDischarge = [consignment.consPodDesc, consignment.consPodCountryName].filter(Boolean).join(', ');
    }

    // Vessel/Voyage from route legs (POL leg)
    const legs = data.blRouteLegs || [];
    if (legs.length > 0) {
      const polLeg = legs.find(l => l.portFromType === 'POL') || legs[0];
      result.vesselVoyage = [polLeg.vesselName, polLeg.voyage ? `${polLeg.voyage}/${polLeg.leg || ''}`.replace(/\/$/, '') : ''].filter(Boolean).join(' / ');
    }

    // Containers and Events from consContainerList
    const containerList = consignment?.consContainerList || [];
    const containers: ContainerInfo[] = [];
    const events: TrackingEvent[] = [];

    for (const c of containerList) {
      const containerNo = `${c.unitPrefix || ''}${(c.unitNo || '').trim()}`;
      containers.push({
        containerNo,
        sizeType: c.cargoType || '',
      });

      // Events from this container's activity list
      for (const act of c.unitActivityList || []) {
        events.push({
          date: act.activityDateTz ? formatDate(act.activityDateTz) : '',
          location: [act.placeFromDesc, act.countryFromName].filter(Boolean).join(', '),
          event: (act.activityDesc || '').trim(),
          vesselVoyage: [act.vesselName, act.voyage ? `${act.voyage}/${act.leg || ''}`.replace(/\/$/, '') : ''].filter(Boolean).join(' / '),
          containerNo,
        });
      }
    }

    result.containers = containers;
    result.events = events;

    if (containers.length === 0 && events.length === 0 && !result.eta) return null;

    return result;
  } catch (err) {
    console.error('[zim] Error:', err);
    cleanup();
    return null;
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
  } catch {
    return dateStr;
  }
}

registry.register({
  id: 'zim',
  displayName: 'ZIM',
  track: trackZIM,
});
