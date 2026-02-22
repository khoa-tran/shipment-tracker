import * as cheerio from 'cheerio';
import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { dumpDebug } from './helpers';

const SEALEAD_URL = 'https://www.sea-lead.com/track-shipment/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': USER_AGENT,
  'Referer': SEALEAD_URL,
};

function normalizeDate(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function isContainerNumber(val: string): boolean {
  return /^[A-Z]{4}\d{7}$/.test(val);
}

function isBLNumber(val: string): boolean {
  return /^SL/i.test(val);
}

type SearchType = 'BL' | 'CNTR';

function detectSearchType(val: string): SearchType {
  if (isContainerNumber(val)) return 'CNTR';
  if (isBLNumber(val)) return 'BL';
  return 'BL';
}

function parseRouteInfo($: cheerio.CheerioAPI, tables: cheerio.Cheerio<cheerio.Element>, result: TrackingResult): void {
  const table0 = tables.eq(0);
  const fieldMap: [string, keyof TrackingResult][] = [
    ['Place of Receipt', 'placeOfReceipt'],
    ['Port of Loading', 'portOfLoading'],
    ['Port of Discharge', 'portOfDischarge'],
    ['Place of Delivery', 'placeOfDelivery'],
  ];

  table0.find('tr').each((_, row) => {
    const th = $(row).find('th').first();
    const td = $(row).find('td').first();
    if (!th.length || !td.length) return;
    const label = cleanText(th.text());
    const value = cleanText(td.text());
    for (const [match, key] of fieldMap) {
      if (label.includes(match) && value) {
        (result as any)[key] = value;
      }
    }
  });
}

function parseVoyageInfo($: cheerio.CheerioAPI, tables: cheerio.Cheerio<cheerio.Element>, result: TrackingResult): void {
  const table1 = tables.eq(1);
  const rows = table1.find('tr');
  if (rows.length < 2) return;

  const dataRow = rows.eq(1);
  const cells = dataRow.find('td');
  if (cells.length < 8) return;

  result.blNo = cleanText($(cells[0]).text());
  result.vesselVoyage = cleanText($(cells[3]).text());
  const rawEta = cleanText($(cells[7]).text());
  result.eta = normalizeDate(rawEta);
}

function parseContainerSummary($: cheerio.CheerioAPI, tables: cheerio.Cheerio<cheerio.Element>): ContainerInfo[] {
  const table2 = tables.eq(2);
  const containers: ContainerInfo[] = [];
  const rows = table2.find('tr');

  // Skip header row (index 0), process data rows
  rows.each((i, row) => {
    if (i === 0) return; // skip header
    const cells = $(row).find('td');
    if (cells.length < 7) return;

    const containerNo = cleanText($(cells[1]).text());
    if (!isContainerNumber(containerNo)) return;

    containers.push({
      containerNo,
      sizeType: cleanText($(cells[2]).text()),
      currentStatus: cleanText($(cells[3]).text()),
      date: normalizeDate(cleanText($(cells[4]).text())),
      location: cleanText($(cells[5]).text()),
      vesselVoyage: cleanText($(cells[6]).text()),
    });
  });

  return containers;
}

function parseContainerEvents($: cheerio.CheerioAPI, tables: cheerio.Cheerio<cheerio.Element>, containerNo: string): TrackingEvent[] {
  const table2 = tables.eq(2);
  const events: TrackingEvent[] = [];
  const rows = table2.find('tr');

  rows.each((i, row) => {
    if (i === 0) return; // skip header
    const cells = $(row).find('td');
    if (cells.length < 7) return;

    const eventName = cleanText($(cells[3]).text());
    const rawDate = cleanText($(cells[4]).text());
    const location = cleanText($(cells[5]).text());
    const vesselVoyage = cleanText($(cells[6]).text());

    if (!eventName && !rawDate) return;

    events.push({
      event: eventName,
      date: normalizeDate(rawDate),
      location,
      vesselVoyage,
      containerNo,
    });
  });

  return events;
}

async function fetchSeaLead(url: string, method: string, body: string | undefined, signal?: AbortSignal): Promise<string> {
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);

  const options: RequestInit = {
    method,
    headers: method === 'POST' ? HEADERS : { 'User-Agent': USER_AGENT, 'Referer': SEALEAD_URL },
    signal: fetchSignal,
  };
  if (body) options.body = body;

  const response = await fetch(url, options);
  return response.text();
}

async function trackSeaLead(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  const searchType = detectSearchType(val);

  let body: string;
  if (searchType === 'BL') {
    body = new URLSearchParams({
      ts_track_option: '1',
      bl_number: val,
      container_id: '',
    }).toString();
  } else {
    body = new URLSearchParams({
      ts_track_option: '2',
      container_id: val,
      bl_number: '',
    }).toString();
  }

  const html = await fetchSeaLead(SEALEAD_URL, 'POST', body, signal);
  dumpDebug('sealead', 'response', html);

  const $ = cheerio.load(html);
  const tables = $('table');

  // Check if results exist — need at least 3 tables
  if (tables.length < 3) {
    return null;
  }

  const result: TrackingResult = {
    carrier: 'Sea Lead',
    trackingUrl: 'https://www.sea-lead.com/track-shipment/',
    containers: [],
    events: [],
    planMoves: [],
  };

  // Table 0: Route info
  parseRouteInfo($, tables, result);

  // Table 1: Voyage info (B/L, vessel/voyage, ETA)
  parseVoyageInfo($, tables, result);

  // Table 2: Container summary
  result.containers = parseContainerSummary($, tables);

  // Per-container event history: only if we have a B/L number (from B/L search)
  if (searchType === 'BL' && result.blNo) {
    const allEvents: TrackingEvent[] = [];

    for (const container of result.containers) {
      try {
        const eventUrl = `${SEALEAD_URL}?container_id=${encodeURIComponent(container.containerNo)}&bl_number=${encodeURIComponent(result.blNo)}`;
        const eventHtml = await fetchSeaLead(eventUrl, 'GET', undefined, signal);
        dumpDebug('sealead', `events-${container.containerNo}`, eventHtml);

        const $e = cheerio.load(eventHtml);
        const eventTables = $e('table');

        if (eventTables.length >= 3) {
          const events = parseContainerEvents($e, eventTables, container.containerNo);
          allEvents.push(...events);
        }
      } catch (e: any) {
        console.log(`[sealead] Failed to fetch events for ${container.containerNo}: ${e?.message || e}`);
      }
    }

    result.events = allEvents;
  }

  return result;
}

registry.register({
  id: 'sealead',
  displayName: 'Sea Lead',
  track: trackSeaLead,
});
