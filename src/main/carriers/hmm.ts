import * as cheerio from 'cheerio';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { dumpDebug } from './helpers';

const HMM_PAGE_URL = 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do';
const HMM_API_URL = 'https://www.hmm21.com/e-service/general/trackNTrace/selectTrackNTrace.do';

type SearchType = 'bl' | 'cntr' | 'bkg';

// HMM SCAC prefixes that should be stripped from B/L numbers
const HMM_PREFIXES = ['HDMU', 'HMMU'];

function detectSearchType(val: string): SearchType {
  if (/^[A-Z]{4}\d{7}$/.test(val)) return 'cntr';
  return 'bl';
}

/** Strip HMM SCAC prefix (e.g. HDMUTAOM84616400 → TAOM84616400) */
function stripHmmPrefix(val: string): string {
  for (const prefix of HMM_PREFIXES) {
    if (val.startsWith(prefix) && val.length > prefix.length + 4) {
      return val.slice(prefix.length);
    }
  }
  return val;
}

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Fetch the Track & Trace page to obtain a session cookie and CSRF token. */
async function getSession(signal?: AbortSignal): Promise<{ cookie: string; csrf: string }> {
  const resp = await fetch(HMM_PAGE_URL, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    signal,
    redirect: 'follow',
  });

  // Extract Set-Cookie headers
  const cookies: string[] = [];
  resp.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      const name = value.split(';')[0];
      cookies.push(name);
    }
  });

  // Extract CSRF token from the HTML
  const html = await resp.text();
  const csrfMatch = html.match(/name="_csrf"\s+content="([^"]+)"/);
  const csrf = csrfMatch?.[1] ?? '';

  return { cookie: cookies.join('; '), csrf };
}

async function trackHMM(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const raw = searchValue.trim().toUpperCase();
  const val = stripHmmPrefix(raw);
  const searchType = detectSearchType(val);

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);

  // Step 1: Get session cookie + CSRF token
  const { cookie, csrf } = await getSession(fetchSignal);
  if (!csrf) return null;

  // Step 2: POST tracking request with session
  const body = {
    type: searchType,
    listBl: searchType === 'bl' ? [val] : [],
    listCntr: searchType === 'cntr' ? [val] : [],
    listBkg: searchType === 'bkg' ? [val] : [],
    listPo: [],
  };

  const response = await fetch(HMM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': HMM_PAGE_URL,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': csrf,
      'Cookie': cookie,
    },
    body: JSON.stringify(body),
    signal: fetchSignal,
  });

  const html = await response.text();
  dumpDebug('hmm', 'response', html);
  const $ = cheerio.load(html);

  // Check for error / denied page
  if (html.includes('error-page') || html.includes('Denied') || $('table').length === 0) return null;

  const result: TrackingResult = {
    carrier: 'HMM',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  // Extract B/L number from hidden inputs
  const blNo = $('#thisBl').val() as string;
  if (blNo) result.blNo = blNo;

  // --- Schedule table (Origin / Loading Port / Discharging Port / Destination) ---
  // Headers: [empty, Origin, Loading Port, Discharging Port, Destination]
  // Rows: Location, Terminal, Arrival(ETB), Departure
  $('table').each((_, table) => {
    const thTexts = $(table).find('thead th div.text, thead td div.text').map((_, el) => cleanText($(el).text())).get();
    if (!thTexts.some(h => /Origin/i.test(h))) return;

    const originIdx = thTexts.findIndex(h => /Origin/i.test(h));
    const loadIdx = thTexts.findIndex(h => /Loading/i.test(h));
    const dischIdx = thTexts.findIndex(h => /Discharg/i.test(h));
    const destIdx = thTexts.findIndex(h => /Destination/i.test(h));

    $(table).find('tbody tr, thead ~ tr').each((_, row) => {
      const th = cleanText($(row).find('th div.text').text());
      const tds = $(row).find('td div.text');
      if (tds.length === 0) return;

      if (/Location/i.test(th)) {
        if (originIdx >= 0) result.placeOfReceipt = cleanText($(tds[originIdx - 1]).text());
        if (loadIdx >= 0) result.portOfLoading = cleanText($(tds[loadIdx - 1]).text());
        if (dischIdx >= 0) result.portOfDischarge = cleanText($(tds[dischIdx - 1]).text());
        if (destIdx >= 0) result.placeOfDelivery = cleanText($(tds[destIdx - 1]).text());
      }
      if (/Arrival/i.test(th) && dischIdx >= 0) {
        const eta = cleanText($(tds[dischIdx - 1]).text());
        if (eta) result.eta = eta;
      }
    });
  });

  // --- Container table ---
  // Headers: No., Container No., Trailer No., Cargo Type, Type / Size, Weight, B/L No., ...
  const containers: ContainerInfo[] = [];
  $('#containerStatus table').each((_, table) => {
    const thTexts = $(table).find('thead th div.text').map((_, el) => cleanText($(el).text())).get();
    const cntrIdx = thTexts.findIndex(h => /Container No/i.test(h));
    const sizeIdx = thTexts.findIndex(h => /Type.*Size/i.test(h));
    const weightIdx = thTexts.findIndex(h => /Weight/i.test(h));
    const sealIdx = thTexts.findIndex(h => /Seal/i.test(h));
    const moveIdx = thTexts.findIndex(h => /^Movement$/i.test(h));
    const moveDateIdx = thTexts.findIndex(h => /Last Movement/i.test(h));

    if (cntrIdx < 0) return;

    $(table).find('tbody tr').each((_, row) => {
      const tds = $(row).find('td');
      if (tds.length < 3) return;

      const cntrEl = $(tds[cntrIdx]).find('div.click');
      const containerNo = cleanText(cntrEl.length ? cntrEl.text() : $(tds[cntrIdx]).text());
      if (!/^[A-Z]{4}\d{7}$/.test(containerNo)) return;

      containers.push({
        containerNo,
        sizeType: sizeIdx >= 0 ? cleanText($(tds[sizeIdx]).find('div.text').text()) : '',
        sealNo: sealIdx >= 0 ? cleanText($(tds[sealIdx]).find('div.text').text()) : undefined,
        latestMove: moveIdx >= 0 ? cleanText($(tds[moveIdx]).find('div.text').text()) : undefined,
        date: moveDateIdx >= 0 ? cleanText($(tds[moveDateIdx]).find('div.text').text()) : undefined,
      });
    });
  });
  result.containers = containers;

  // --- Vessel Movement table ---
  // Headers: Vessel / Voyage, Route, Loading Port, Departure, Discharging Port, Arrival
  $('div.tab-inner').each((_, section) => {
    const title = cleanText($(section).find('div.tab-title').first().text());
    if (!/Vessel Movement/i.test(title)) return;

    $(section).find('tbody tr').each((_, row) => {
      const tds = $(row).find('td div.text');
      if (tds.length >= 6) {
        result.vesselVoyage = cleanText($(tds[0]).text());
      }
    });
  });

  // --- Current Location table ---
  // Headers: Location, Date / Time, Status Description
  $('div.tab-inner').each((_, section) => {
    const title = cleanText($(section).find('div.tab-title').first().text());
    if (!/Current Location/i.test(title)) return;

    $(section).find('tbody tr').first().each((_, row) => {
      const tds = $(row).find('td div.text');
      if (tds.length >= 3) {
        const location = cleanText($(tds[0]).text());
        const dateTime = cleanText($(tds[1]).text());
        const status = cleanText($(tds[2]).text());
        // Use current location date as a fallback ETA if we didn't get one from the schedule table
        if (!result.eta && dateTime) {
          result.eta = dateTime.split(' ')[0];
        }
      }
    });
  });

  // --- Shipment Progress events (shown when clicking a container) ---
  // The B/L-level response may not include per-container events, but if present:
  // Headers: Date, Time, Location, Status Description, Vessel / Voyage
  $('div.tab-inner').each((_, section) => {
    const title = cleanText($(section).find('div.tab-title').first().text());
    if (!/Shipment Progress/i.test(title)) return;

    $(section).find('tbody tr').each((_, row) => {
      const tds = $(row).find('td div.text');
      if (tds.length < 4) return;

      const date = cleanText($(tds[0]).text());
      if (!/\d{4}-\d{2}-\d{2}/.test(date)) return;

      const time = cleanText($(tds[1]).text());
      const location = cleanText($(tds[2]).text());
      const status = cleanText($(tds[3]).text());
      const vessel = tds.length > 4 ? cleanText($(tds[4]).text()) : '';

      result.events.push({
        date: time ? `${date} ${time}` : date,
        location,
        event: status,
        vesselVoyage: vessel || undefined,
      });
    });
  });

  // Return null if we got no meaningful data
  if (containers.length === 0 && result.events.length === 0 && !result.eta && !result.portOfLoading) return null;

  return result;
}

registry.register({
  id: 'hmm',
  displayName: 'HMM',
  track: trackHMM,
});
