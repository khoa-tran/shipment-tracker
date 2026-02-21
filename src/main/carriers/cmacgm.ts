import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface CMAData {
  bls?: Array<{
    blNumber?: string;
    pol?: string;
    pod?: string;
    eta?: string;
    vessel?: string;
    voyage?: string;
    containers?: Array<{
      containerNumber?: string;
      containerType?: string;
      sealNumber?: string;
      lastEvent?: string;
      movements?: Array<{
        date?: string;
        location?: string;
        description?: string;
        vessel?: string;
        voyage?: string;
      }>;
    }>;
  }>;
  [key: string]: any;
}

async function trackCMACGM(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: `https://www.cma-cgm.com/ebusiness/tracking/search?Reference=${val}`,
    responseUrlMatch: 'tracking',
    timeout: 45000,
    initialDelay: 5000,
    cookieDismissSelector: '#onetrust-accept-btn-handler',
    pageScript: () => `void(0)`, // URL-based tracking
  }, val, signal) as CMAData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'CMA CGM',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  const bls = json.bls || [];
  if (bls.length > 0) {
    const bl = bls[0];
    result.blNo = bl.blNumber;
    result.portOfLoading = bl.pol;
    result.portOfDischarge = bl.pod;
    result.eta = bl.eta;
    result.vesselVoyage = [bl.vessel, bl.voyage].filter(Boolean).join(' / ');

    const containers: ContainerInfo[] = [];
    const events: TrackingEvent[] = [];

    for (const c of bl.containers || []) {
      containers.push({
        containerNo: c.containerNumber || '',
        sizeType: c.containerType || '',
        sealNo: c.sealNumber || '',
        latestMove: c.lastEvent || '',
      });

      for (const m of c.movements || []) {
        events.push({
          date: m.date || '',
          location: m.location || '',
          event: m.description || '',
          vesselVoyage: [m.vessel, m.voyage].filter(Boolean).join(' / '),
        });
      }
    }

    result.containers = containers;
    result.events = events;
  }

  if (result.containers.length === 0 && result.events.length === 0 && !result.eta) return null;

  return result;
}

registry.register({
  id: 'cmacgm',
  displayName: 'CMA CGM',
  track: trackCMACGM,
});
