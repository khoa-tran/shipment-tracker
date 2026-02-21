import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface ZIMData {
  data?: {
    containers?: Array<{
      containerNumber?: string;
      containerType?: string;
      sealNumber?: string;
      lastEvent?: string;
      eta?: string;
      pol?: string;
      pod?: string;
      blNumber?: string;
      vesselName?: string;
      voyageNumber?: string;
      events?: Array<{
        date?: string;
        location?: string;
        description?: string;
        vessel?: string;
        voyage?: string;
      }>;
    }>;
  };
  [key: string]: any;
}

async function trackZIM(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    carrierId: 'zim',
    url: 'https://www.zim.com/tools/track-a-shipment',
    responseUrlMatch: 'track',
    timeout: 45000,
    initialDelay: 4000,
    cookieDismissSelector: '#onetrust-accept-btn-handler',
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('input[data-testid="consnumber-input"], input[name="consnumber"], input[placeholder*="tracking"], input[placeholder*="container"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('button[data-testid="search-btn"], button[type="submit"], .search-button');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as ZIMData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'ZIM',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const c of json.data?.containers || []) {
    if (c.eta) result.eta = c.eta;
    if (c.pol) result.portOfLoading = c.pol;
    if (c.pod) result.portOfDischarge = c.pod;
    if (c.blNumber) result.blNo = c.blNumber;
    if (c.vesselName) result.vesselVoyage = [c.vesselName, c.voyageNumber].filter(Boolean).join(' / ');

    containers.push({
      containerNo: c.containerNumber || '',
      sizeType: c.containerType || '',
      sealNo: c.sealNumber || '',
      latestMove: c.lastEvent || '',
    });

    for (const ev of c.events || []) {
      events.push({
        date: ev.date || '',
        location: ev.location || '',
        event: ev.description || '',
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
  id: 'zim',
  displayName: 'ZIM',
  track: trackZIM,
});
