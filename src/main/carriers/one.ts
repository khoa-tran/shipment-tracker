import { net } from 'electron';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { dumpDebug } from './helpers';

const BASE = 'https://ecomm.one-line.com/api/v1/edh';

// --- API response types ---

interface SearchEntry {
  bookingNo?: string;
  containerNo?: string;
  containerTypeSize?: string;
  weight?: string;
  socFlag?: boolean;
  seals?: Array<{ sealNo?: string }>;
  por?: { locationName?: string; countryName?: string };
  pod?: { locationName?: string; countryName?: string };
  place?: { yardName?: string; locationName?: string };
  latestEvent?: { eventName?: string; locationName?: string; date?: string };
}

interface SearchResponse {
  status?: number;
  code?: number;
  total?: number;
  data?: SearchEntry[];
}

interface VoyageLeg {
  vesselEngName?: string;
  inboundConsortiumVoyage?: string;
  pol?: { locationName?: string; date?: string };
  pod?: { locationName?: string; arrivalDate?: string };
}

interface VoyageResponse {
  status?: number;
  data?: VoyageLeg[];
}

interface CopEvent {
  eventName?: string;
  eventLocalPortDate?: string;
  triggerType?: string;
  location?: { locationName?: string; countryName?: string };
  yard?: { yardName?: string };
  vessel?: { name?: string; voyNo?: string; dirCode?: string };
}

interface CopEventsResponse {
  status?: number;
  data?: CopEvent[];
}

// --- Helpers ---

function stripPrefix(value: string): string {
  const v = value.trim().toUpperCase();
  return v.startsWith('ONEY') ? v.slice(4) : v;
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

function httpGet<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  return httpRequest<T>('GET', url, undefined, signal);
}

function httpPost<T>(url: string, body: object, signal?: AbortSignal): Promise<T | null> {
  return httpRequest<T>('POST', url, body, signal);
}

function httpRequest<T>(method: string, url: string, body?: object, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30000);
    const cleanup = () => clearTimeout(timer);

    if (signal?.aborted) { cleanup(); resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const request = net.request({ url, method });
      request.setHeader('Accept', 'application/json');
      request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
      if (body) {
        request.setHeader('Content-Type', 'application/json');
      }

      let data = '';
      request.on('response', (response) => {
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          cleanup();
          signal?.removeEventListener('abort', onAbort);
          try { resolve(JSON.parse(data) as T); }
          catch { resolve(null); }
        });
      });

      request.on('error', () => {
        cleanup();
        signal?.removeEventListener('abort', onAbort);
        resolve(null);
      });

      if (body) {
        request.write(JSON.stringify(body));
      }
      request.end();
    } catch {
      cleanup();
      signal?.removeEventListener('abort', onAbort);
      resolve(null);
    }
  });
}

// --- Main tracking function ---

async function trackONE(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const bookingNo = stripPrefix(searchValue);
  console.log(`[one] Tracking: ${bookingNo}`);

  // Step 1: Search — gets container details, POR, POD, weight, size
  const searchResp = await httpPost<SearchResponse>(
    `${BASE}/containers/track-and-trace/search`,
    {
      page: 1,
      page_length: 10,
      filters: { search_text: bookingNo, search_type: 'BKG_NO' },
      timestamp: Date.now(),
    },
    signal,
  );

  if (!searchResp?.data || searchResp.data.length === 0) {
    console.log('[one] No search results');
    return null;
  }

  dumpDebug('one', 'search', JSON.stringify(searchResp, null, 2));

  const result: TrackingResult = {
    carrier: 'ONE',
    trackingNo: bookingNo,
    containers: [],
    events: [],
    planMoves: [],
  };

  // Build containers from search results and collect container numbers
  const containerNos: string[] = [];
  for (const entry of searchResp.data) {
    if (entry.containerNo) {
      containerNos.push(entry.containerNo);
      result.containers.push({
        containerNo: entry.containerNo,
        sizeType: entry.containerTypeSize || '',
        sealNo: entry.seals?.[0]?.sealNo || '',
        currentStatus: entry.latestEvent?.eventName || '',
        location: entry.place?.locationName || '',
        date: entry.latestEvent?.date ? formatDate(entry.latestEvent.date) : '',
      });
    }
  }

  // POR / POD from first search entry
  const first = searchResp.data[0];
  if (first.por) {
    result.placeOfReceipt = [first.por.locationName, first.por.countryName].filter(Boolean).join(', ');
  }
  if (first.pod) {
    result.placeOfDelivery = [first.pod.locationName, first.pod.countryName].filter(Boolean).join(', ');
  }

  // Step 2: Voyage list — vessel legs, POL, POD ports, ETA
  const voyageResp = await httpGet<VoyageResponse>(
    `${BASE}/vessel/track-and-trace/voyage-list?booking_no=${encodeURIComponent(bookingNo)}`,
    signal,
  );

  if (voyageResp?.data && voyageResp.data.length > 0) {
    dumpDebug('one', 'voyage-list', JSON.stringify(voyageResp, null, 2));

    const legs = voyageResp.data;
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    if (firstLeg.vesselEngName) {
      result.vesselVoyage = [firstLeg.vesselEngName, firstLeg.inboundConsortiumVoyage].filter(Boolean).join(' / ');
    }
    if (firstLeg.pol?.locationName) result.portOfLoading = firstLeg.pol.locationName;
    if (lastLeg.pod?.locationName) result.portOfDischarge = lastLeg.pod.locationName;
    if (lastLeg.pod?.arrivalDate) result.eta = formatDate(lastLeg.pod.arrivalDate);
  }

  // Step 3: Cop-events for each container — full event timeline
  for (const cno of containerNos) {
    const eventsResp = await httpGet<CopEventsResponse>(
      `${BASE}/containers/track-and-trace/cop-events?booking_no=${encodeURIComponent(bookingNo)}&container_no=${encodeURIComponent(cno)}`,
      signal,
    );

    if (eventsResp?.data) {
      dumpDebug('one', `cop-events-${cno}`, JSON.stringify(eventsResp, null, 2));
      for (const ev of eventsResp.data) {
        const vesselParts = [ev.vessel?.name, ev.vessel?.voyNo].filter(Boolean);
        result.events.push({
          date: ev.eventLocalPortDate ? formatDate(ev.eventLocalPortDate) : '',
          location: [ev.location?.locationName, ev.location?.countryName].filter(Boolean).join(', '),
          event: ev.eventName || '',
          terminal: ev.yard?.yardName,
          vesselVoyage: vesselParts.length > 0 ? vesselParts.join(' / ') : undefined,
        });
      }
    }
  }

  if (result.containers.length === 0 && result.events.length === 0 && !result.eta) return null;

  return result;
}

registry.register({
  id: 'one',
  displayName: 'ONE',
  track: trackONE,
});
