import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface HapagData {
  containers?: Array<{
    containerNumber?: string;
    containerType?: string;
    sealNumber?: string;
    latestEvent?: string;
    eta?: string;
    pol?: string;
    pod?: string;
    blNumber?: string;
    events?: Array<{
      date?: string;
      location?: string;
      status?: string;
      vessel?: string;
      voyage?: string;
    }>;
  }>;
  [key: string]: any;
}

async function trackHapag(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html',
    responseUrlMatch: 'track',
    timeout: 45000,
    initialDelay: 4000,
    cookieDismissSelector: '#cookie-consent-accept, .cookie-consent__accept',
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('#container-number, input[name="containerNumber"], input[placeholder*="container"], input[placeholder*="tracking"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('button[type="submit"], .btn-submit, .search-btn');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as HapagData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'Hapag-Lloyd',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const c of json.containers || []) {
    if (c.eta) result.eta = c.eta;
    if (c.pol) result.portOfLoading = c.pol;
    if (c.pod) result.portOfDischarge = c.pod;
    if (c.blNumber) result.blNo = c.blNumber;

    containers.push({
      containerNo: c.containerNumber || '',
      sizeType: c.containerType || '',
      sealNo: c.sealNumber || '',
      latestMove: c.latestEvent || '',
    });

    for (const ev of c.events || []) {
      events.push({
        date: ev.date || '',
        location: ev.location || '',
        event: ev.status || '',
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
  id: 'hapag',
  displayName: 'Hapag-Lloyd',
  track: trackHapag,
});
