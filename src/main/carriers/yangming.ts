import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { dumpDebug } from './helpers';

const API_BASE = 'https://www.yangming.com/api/CargoTracking/GetTracking';
const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

/** Strip HTML tags like <BR /> from API text fields */
function cleanHtml(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extract vessel/voyage from tsMode field like "HMM RUBY<BR />(011E)" */
function parseVesselVoyage(tsMode: string | null): string {
  if (!tsMode) return '';
  const clean = cleanHtml(tsMode);
  // e.g. "HMM RUBY (011E)" → "HMM RUBY 011E"
  return clean.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

async function trackYangMing(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  // Step 1: Search by B/L or booking number
  const searchUrl = `${API_BASE}?paramTrackNo=${encodeURIComponent(val)}&paramTrackPosition=SEARCH&paramRefNo=`;
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);

  const searchResp = await fetch(searchUrl, { headers: HEADERS, signal: fetchSignal });
  if (!searchResp.ok) return null;

  const searchData = await searchResp.json();
  dumpDebug('yangming', 'search-response', JSON.stringify(searchData, null, 2));

  if (!searchData.successCnt || searchData.successCnt === 0) return null;

  const bl = searchData.blList?.[0] || searchData.bookingList?.[0];
  if (!bl) return null;

  const basic = bl.basicInfo || {};
  const routing = bl.routingInfo?.routingSchedule || [];

  // Find ETA from routing — last entry with dateQlfr
  let eta = '';
  for (const r of routing) {
    if (r.placeName && r.dateTime) {
      eta = r.dateTime.split(' ')[0]; // "2026/02/12 02:49" → "2026/02/12"
    }
  }

  const result: TrackingResult = {
    carrier: 'Yang Ming',
    trackingNo: val,
    blNo: bl.returnTrackNo || val,
    vesselVoyage: basic.vesselName ? `${basic.vesselName} ${basic.vesselComn || ''}`.trim() : undefined,
    eta: eta || undefined,
    portOfLoading: basic.loading ? cleanHtml(basic.loading) : undefined,
    portOfDischarge: basic.discharge ? cleanHtml(basic.discharge) : undefined,
    placeOfReceipt: basic.receipt ? cleanHtml(basic.receipt) : undefined,
    placeOfDelivery: basic.delivery ? cleanHtml(basic.delivery) : undefined,
    onBoardDate: basic.obDate || undefined,
    grossWeight: basic.grossWgt ? `${basic.grossWgt} ${basic.grossWgtUnit || ''}`.trim() : undefined,
    measurement: basic.cbm ? `${basic.cbm} ${basic.cbmUnit || ''}`.trim() : undefined,
    containerCount: basic.ctnrUnit || undefined,
    serviceMode: basic.serviceTerm || undefined,
    trackingUrl: 'https://www.yangming.com/en/esolution/cargo_tracking',
    containers: [],
    events: [],
    planMoves: [],
  };

  // Step 2: For each container, fetch detailed event history
  const containerInfoList = bl.containerInfo || [];
  for (const c of containerInfoList) {
    const ctnrNo = c.ctnrNo || '';
    if (!ctnrNo) continue;

    const container: ContainerInfo = {
      containerNo: ctnrNo,
      sizeType: `${c.cnSize || ''} ${c.cnType || ''}`.trim(),
      sealNo: c.sealNo || undefined,
      currentStatus: c.lastEvent || undefined,
      date: c.moveDate || undefined,
      location: c.place ? cleanHtml(c.place) : undefined,
      vgm: c.vgm ? `${c.vgm} ${c.vgmUnit || ''}`.trim() : undefined,
    };
    result.containers.push(container);

    // Fetch container event details
    try {
      const detailUrl = `${API_BASE}?paramTrackNo=${encodeURIComponent(ctnrNo)}&paramTrackPosition=BL_CT&paramRefNo=${encodeURIComponent(val)}`;
      const detailSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000);
      const detailResp = await fetch(detailUrl, { headers: HEADERS, signal: detailSignal });
      if (!detailResp.ok) continue;

      const detailData = await detailResp.json();
      dumpDebug('yangming', `container-${ctnrNo}`, JSON.stringify(detailData, null, 2));

      const ctList = detailData.containerList?.[0]?.ctStatusInfo || [];
      for (const ev of ctList) {
        result.events.push({
          date: ev.moveDate || '',
          location: ev.atFacility ? cleanHtml(ev.atFacility) : '',
          event: ev.eventDesc || '',
          vesselVoyage: parseVesselVoyage(ev.tsMode) || undefined,
          containerNo: ctnrNo,
        });
      }
    } catch {
      // Container detail fetch failed — continue with basic info
    }
  }

  // Build planMoves from routing schedule
  for (const r of routing) {
    if (r.placeName && r.dateTime) {
      result.planMoves.push({
        eta: r.dateTime,
        location: r.placeName,
        vesselVoyage: result.vesselVoyage || '',
      });
    }
  }

  return result;
}

registry.register({
  id: 'yangming',
  displayName: 'Yang Ming',
  track: trackYangMing,
});
