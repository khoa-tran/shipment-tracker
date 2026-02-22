import { BrowserWindow } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { delay, dumpDebug } from './helpers';

interface MaerskLocation {
  terminal?: string;
  city?: string;
  state?: string | null;
  country?: string;
  country_code?: string;
  site_type?: string;
  location_code?: string;
  events?: MaerskEvent[];
}

interface MaerskEvent {
  type?: string;
  eventId?: string;
  locationCode?: string;
  activity?: string;
  stempty?: boolean;
  actfor?: string;
  event_time?: string;
  event_time_type?: string;
  vessel_name?: string;
  voyage?: string;
  voyage_num?: string;
}

interface MaerskContainer {
  container_num?: string;
  container_size?: string;
  container_type?: string;
  iso_code?: string;
  shipment_num?: string;
  operator?: string;
  locations?: MaerskLocation[];
  eta_final_delivery?: string;
}

interface MaerskData {
  date_time?: string;
  origin?: {
    terminal?: string;
    city?: string;
    country?: string;
    country_code?: string;
    location_code?: string;
  };
  destination?: {
    terminal?: string;
    city?: string;
    country?: string;
    country_code?: string;
    location_code?: string;
  };
  containers?: MaerskContainer[];
}

async function trackMaersk(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  // Strip spaces and known Maersk operator prefixes to get raw BL/container number
  const val = searchValue.trim().toUpperCase().replace(/\s+/g, '').replace(/^(MAEU|MSKU|SEAU)/, '');
  console.log(`[maersk] Tracking: ${val}`);

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
      console.log('[maersk] Timeout reached');
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

    // Use Chrome user agent to bypass Akamai bot detection
    const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(chromeUA);

    win.webContents.on('did-fail-load', (_e: any, code: any, desc: any, url: any) => {
      console.log(`[maersk] Page failed to load: ${code} ${desc} ${url}`);
      finish(null);
    });

    // Load base tracking page first to let Akamai bot-manager cookies generate,
    // then navigate to the tracking URL via Vue Router (client-side)
    const baseUrl = 'https://www.maersk.com/tracking/';
    console.log(`[maersk] Loading: ${baseUrl}`);
    win.loadURL(baseUrl).catch(() => finish(null));

    let pageLoaded = false;
    win.webContents.on('did-finish-load', async () => {
      try {
        if (resolved || pageLoaded) return;
        pageLoaded = true;
        const loadedUrl = win!.webContents.getURL();
        console.log(`[maersk] Page loaded: ${loadedUrl}`);

        // Wait for Akamai scripts to run and generate cookies
        await delay(3000);
        if (resolved) return;

        // Navigate via Vue Router (client-side, no page reload, preserves Akamai cookies)
        // Navigate via Vue Router (client-side, no page reload, preserves Akamai cookies)
        await win!.webContents.executeJavaScript(`
          (function() {
            for (var i = 0; i < document.querySelectorAll('*').length; i++) {
              var el = document.querySelectorAll('*')[i];
              if (el.__vue_app__) {
                var router = el.__vue_app__.config.globalProperties.$router;
                if (router) { router.push('/tracking/${val}'); return; }
              }
            }
          })();
        `).catch(() => {});

        // Poll for Pinia store to have tracking data
        const maxPoll = 25000;
        const interval = 1000;
        const start = Date.now();
        let json: MaerskData | null = null;

        while (Date.now() - start < maxPoll && !resolved) {
          const result = await win!.webContents.executeJavaScript(`
            (function() {
              for (var i = 0; i < document.querySelectorAll('*').length; i++) {
                var el = document.querySelectorAll('*')[i];
                if (el.__vue_app__) {
                  var pinia = el.__vue_app__.config.globalProperties.$pinia;
                  if (pinia && pinia.state && pinia.state.value && pinia.state.value.track) {
                    var resp = pinia.state.value.track.trackingResponse;
                    if (resp && resp.containers && resp.containers.length > 0) {
                      return JSON.stringify(resp);
                    }
                  }
                }
              }
              return null;
            })();
          `).catch(() => null);

          if (result) {
            try {
              json = JSON.parse(result);
              break;
            } catch {
              // not valid JSON yet
            }
          }
          await delay(interval);
        }

        if (!json || !json.containers || json.containers.length === 0) {
          console.log('[maersk] No tracking data found');
          finish(null);
          return;
        }

        dumpDebug('maersk', 'response', JSON.stringify(json, null, 2));
        finish(parseMaerskJson(json, val));
      } catch (e: any) {
        console.log(`[maersk] Error: ${e?.message || e}`);
        finish(null);
      }
    });
  });
}

function parseMaerskJson(data: MaerskData, trackingNo: string): TrackingResult | null {
  const cntrList = data.containers;
  if (!cntrList || cntrList.length === 0) return null;

  const result: TrackingResult = {
    carrier: 'Maersk',
    trackingNo,
    blNo: cntrList[0]?.shipment_num,
    trackingUrl: `https://www.maersk.com/tracking/${trackingNo}`,
    containers: [],
    events: [],
    planMoves: [],
  };

  if (data.origin) {
    result.portOfLoading = [data.origin.city, data.origin.country].filter(Boolean).join(', ');
  }
  if (data.destination) {
    result.portOfDischarge = [data.destination.city, data.destination.country].filter(Boolean).join(', ');
  }

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  let latestVessel = '';

  for (const cntr of cntrList) {
    const sizeType = [cntr.container_size, cntr.container_type, cntr.iso_code]
      .filter(Boolean).join(' / ');

    // Use eta_final_delivery from container data
    if (cntr.eta_final_delivery && !result.eta) {
      result.eta = cntr.eta_final_delivery;
    }

    let latestMove = '';
    let latestTime = '';

    for (const loc of cntr.locations || []) {
      for (const ev of loc.events || []) {
        const eventTime = ev.event_time || '';
        const location = [loc.city, loc.country].filter(Boolean).join(', ');
        const voyage = ev.voyage_num || ev.voyage || '';
        const vesselVoyage = [ev.vessel_name, voyage].filter(Boolean).join(' / ');

        events.push({
          date: eventTime,
          location,
          event: ev.activity || '',
          vesselVoyage,
          terminal: loc.terminal || '',
          containerNo: cntr.container_num || '',
        });

        // Track latest actual event and its vessel
        if (ev.event_time_type === 'ACTUAL' && eventTime > latestTime) {
          latestTime = eventTime;
          latestMove = `${ev.activity || ''} - ${location}`;
          if (vesselVoyage) latestVessel = vesselVoyage;
        }
      }
    }

    containers.push({
      containerNo: cntr.container_num || '',
      sizeType,
      latestMove,
    });
  }

  result.containers = containers;
  result.events = events;
  if (latestVessel) result.vesselVoyage = latestVessel;

  if (containers.length === 0 && events.length === 0) return null;

  return result;
}

registry.register({
  id: 'maersk',
  displayName: 'Maersk',
  track: trackMaersk,
});
