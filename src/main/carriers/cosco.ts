import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface COSCOData {
  data?: {
    content?: {
      containers?: Array<{
        containerNo?: string;
        containerType?: string;
        sealNo?: string;
        latestEvent?: string;
        eta?: string;
        pol?: string;
        pod?: string;
        blNo?: string;
        vesselName?: string;
        voyageNo?: string;
        events?: Array<{
          timeOfIssue?: string;
          location?: string;
          transportation?: string;
          vessel?: string;
          voyage?: string;
        }>;
      }>;
    };
  };
  [key: string]: any;
}

async function trackCOSCO(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    carrierId: 'cosco',
    url: 'https://elines.coscoshipping.com/ebusiness/cargoTracking',
    responseUrlMatch: 'cargoTracking',
    timeout: 45000,
    initialDelay: 4000,
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('input[placeholder*="B/L"], input[placeholder*="container"], .ant-input, input[type="text"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('button.ant-btn-primary, button[type="submit"], .search-btn');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as COSCOData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'COSCO',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const c of json.data?.content?.containers || []) {
    if (c.eta) result.eta = c.eta;
    if (c.pol) result.portOfLoading = c.pol;
    if (c.pod) result.portOfDischarge = c.pod;
    if (c.blNo) result.blNo = c.blNo;
    if (c.vesselName) result.vesselVoyage = [c.vesselName, c.voyageNo].filter(Boolean).join(' / ');

    containers.push({
      containerNo: c.containerNo || '',
      sizeType: c.containerType || '',
      sealNo: c.sealNo || '',
      latestMove: c.latestEvent || '',
    });

    for (const ev of c.events || []) {
      events.push({
        date: ev.timeOfIssue || '',
        location: ev.location || '',
        event: ev.transportation || '',
        vesselVoyage: [ev.vessel, ev.voyage].filter(Boolean).join(' / '),
      });
    }
  }

  result.containers = containers;
  result.events = events;

  if (containers.length === 0 && events.length === 0 && !result.eta) return null;

  return result;
}

registry.register({
  id: 'cosco',
  displayName: 'COSCO',
  track: trackCOSCO,
});
