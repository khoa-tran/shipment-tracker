import * as cheerio from 'cheerio';
import { TrackingResult, ContainerInfo, PlanMove } from './types';
import { registry } from './registry';
import { dumpDebug } from './helpers';

const EVERGREEN_URL = 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do';
const HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': EVERGREEN_URL,
};

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function isContainerNumber(val: string): boolean {
  return /^[A-Z]{4}\d{7}$/.test(val);
}

function looksLikeDate(val: string): boolean {
  return /^[A-Z]{3}-\d{2}-\d{4}$/.test(val) ||
    /^\d{4}-\d{2}-\d{2}/.test(val) ||
    /^\d{2}\/\d{2}\/\d{4}$/.test(val);
}

function extractField($: cheerio.CheerioAPI, label: string): string {
  let result = '';
  $('th').each((_, el) => {
    const thText = $(el).text().trim();
    if (thText.includes(label)) {
      const td = $(el).next('td');
      if (td.length) {
        result = cleanText(td.html() || '');
      }
    }
  });
  return result;
}

type SearchType = 'BL' | 'CNTR' | 'BK';

function detectSearchType(val: string): SearchType {
  if (/^\d{12}$/.test(val)) return 'BL';
  if (/^[A-Z]{4}\d{7}$/.test(val)) return 'CNTR';
  return 'BL';
}

async function trackEvergreen(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();
  const searchType = detectSearchType(val);

  let formData: Record<string, string>;
  if (searchType === 'BL') {
    formData = { TYPE: 'BL', BL: val, CNTR: '', bkno: '', NO: val, SEL: 's_bl' };
  } else if (searchType === 'CNTR') {
    formData = { TYPE: 'CNTR', BL: '', CNTR: val, bkno: '', NO: val, SEL: 's_cntr' };
  } else {
    formData = { TYPE: 'BK', BL: '', CNTR: '', bkno: val, NO: val, SEL: 's_bk' };
  }

  const body = new URLSearchParams(formData).toString();
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const response = await fetch(EVERGREEN_URL, {
    method: 'POST',
    headers: HEADERS,
    body,
    signal: fetchSignal,
  });

  const html = await response.text();
  dumpDebug('evergreen', 'response', html);

  if (!html.includes('Vessel Voyage on B/L')) {
    return null;
  }

  const $ = cheerio.load(html);
  const result: TrackingResult = {
    carrier: 'Evergreen',
    trackingUrl: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do',
    containers: [],
    events: [],
    planMoves: [],
  };

  if (searchType === 'BL') {
    result.blNo = extractField($, 'B/L No.');
    result.vesselVoyage = extractField($, 'Vessel Voyage on B/L');

    const etaMatch = html.match(/Estimated Date of Arrival at Destination\s*:\s*<font[^>]*>(.*?)<\/font>/s);
    if (etaMatch) {
      result.eta = cleanText(etaMatch[1]);
    }

    const fieldMap: [string, keyof TrackingResult][] = [
      ['Place of Receipt', 'placeOfReceipt'],
      ['Port of Loading', 'portOfLoading'],
      ['Port of Discharge', 'portOfDischarge'],
      ['Place of Delivery', 'placeOfDelivery'],
      ['Container Count', 'containerCount'],
      ['Gross Weight', 'grossWeight'],
      ['Measurement', 'measurement'],
      ['Manifest Quantity', 'manifestQuantity'],
      ['Estimated On Board Date', 'onBoardDate'],
      ['Service Mode', 'serviceMode'],
    ];

    for (const [label, key] of fieldMap) {
      const val = extractField($, label);
      if (val) {
        (result as any)[key] = val;
      }
    }

    const containerMap = new Map<string, ContainerInfo>();
    $('table').each((_, table) => {
      const tableHtml = $(table).html() || '';
      if (tableHtml.includes('Container(s) information on B/L')) {
        $(table).find('tr').each((_, row) => {
          const cells = $(row).find('td');
          if (cells.length >= 8) {
            const containerNo = cleanText($(cells[0]).html() || '');
            if (!isContainerNumber(containerNo)) return;
            if (containerMap.has(containerNo)) return;
            containerMap.set(containerNo, {
              containerNo,
              sizeType: cleanText($(cells[1]).html() || ''),
              sealNo: cleanText($(cells[2]).html() || ''),
              serviceType: cleanText($(cells[3]).html() || ''),
              quantity: cleanText($(cells[4]).html() || ''),
              vgm: cleanText($(cells[6]).html() || ''),
              currentStatus: cleanText($(cells[7]).html() || ''),
              date: cells.length > 8 ? cleanText($(cells[8]).html() || '') : '',
            });
          }
        });
      }
    });
    result.containers = Array.from(containerMap.values());

    const planMovesSet = new Set<string>();
    const planMoves: PlanMove[] = [];
    $('table').each((_, table) => {
      const tableHtml = $(table).html() || '';
      if (tableHtml.includes('Plan Moves')) {
        $(table).find('tr').each((_, row) => {
          const cells = $(row).find('td');
          if (cells.length >= 3) {
            const eta = cleanText($(cells[0]).html() || '');
            if (!looksLikeDate(eta)) return;
            const location = cleanText($(cells[1]).html() || '');
            const key = `${eta}|${location}`;
            if (planMovesSet.has(key)) return;
            planMovesSet.add(key);
            planMoves.push({
              eta,
              location,
              vesselVoyage: cleanText($(cells[2]).html() || ''),
            });
          }
        });
      }
    });
    result.planMoves = planMoves;

  } else {
    result.vesselVoyage = extractField($, 'Vessel Voyage on B/L');

    const etaMatch = html.match(/Estimated Date of Arrival\s*:(?:\s*<br\s*\/?>)?\s*([A-Z]{3}-\d{2}-\d{4})/);
    if (etaMatch) {
      result.eta = etaMatch[1];
    }

    const cntrMap = new Map<string, ContainerInfo>();
    $('table').each((_, table) => {
      const tableHtml = $(table).html() || '';
      if (tableHtml.includes('Container(s) information on B/L')) {
        $(table).find('tr').each((_, row) => {
          const cells = $(row).find('td');
          if (cells.length >= 6) {
            const containerNo = cleanText($(cells[0]).html() || '');
            if (!isContainerNumber(containerNo)) return;
            if (cntrMap.has(containerNo)) return;
            cntrMap.set(containerNo, {
              containerNo,
              sizeType: cleanText($(cells[1]).html() || ''),
              date: cleanText($(cells[2]).html() || ''),
              currentStatus: cleanText($(cells[3]).html() || ''),
              location: cleanText($(cells[4]).html() || ''),
              vesselVoyage: cleanText($(cells[5]).html() || ''),
              vgm: cells.length > 7 ? cleanText($(cells[7]).html() || '') : '',
            });
          }
        });
      }
    });
    result.containers = Array.from(cntrMap.values());
  }

  return result;
}

registry.register({
  id: 'evergreen',
  displayName: 'Evergreen',
  track: trackEvergreen,
});
