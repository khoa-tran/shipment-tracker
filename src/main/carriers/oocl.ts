import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface OOCLTrackingData {
  content?: {
    body?: {
      trackingBLList?: Array<{
        blNo?: string;
        polName?: string;
        podName?: string;
        eta?: string;
        containerList?: Array<{
          cntrNo?: string;
          cntrType?: string;
          cntrStatus?: string;
          eventList?: Array<{
            eventDt?: string;
            placeName?: string;
            activityDesc?: string;
            vesselName?: string;
            voyageNo?: string;
          }>;
        }>;
      }>;
    };
  };
  [key: string]: any;
}

async function trackOOCL(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: `https://www.oocl.com/eng/ourservices/eservices/cargotracking/`,
    responseUrlMatch: 'cargotracking',
    timeout: 45000,
    initialDelay: 3000,
    cookieDismissSelector: '#onetrust-accept-btn-handler',
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('#searchNumber, input[name="SearchNumber"], input[type="text"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('button[type="submit"], .search-btn, input[type="submit"]');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as OOCLTrackingData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'OOCL',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  // Try to parse structured JSON response
  const blList = json.content?.body?.trackingBLList;
  if (blList && blList.length > 0) {
    const bl = blList[0];
    result.blNo = bl.blNo;
    result.portOfLoading = bl.polName;
    result.portOfDischarge = bl.podName;
    result.eta = bl.eta;

    for (const cntr of bl.containerList || []) {
      result.containers.push({
        containerNo: cntr.cntrNo || '',
        sizeType: cntr.cntrType || '',
        currentStatus: cntr.cntrStatus || '',
      });

      for (const ev of cntr.eventList || []) {
        result.events.push({
          date: ev.eventDt || '',
          location: ev.placeName || '',
          event: ev.activityDesc || '',
          vesselVoyage: [ev.vesselName, ev.voyageNo].filter(Boolean).join(' / '),
        });
      }
    }
  }

  if (result.containers.length === 0 && result.events.length === 0) return null;

  return result;
}

registry.register({
  id: 'oocl',
  displayName: 'OOCL',
  track: trackOOCL,
});
