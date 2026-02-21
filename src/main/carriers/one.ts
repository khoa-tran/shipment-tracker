import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface ONEData {
  blNo?: string;
  pol?: string;
  pod?: string;
  eta?: string;
  vesselName?: string;
  voyageNo?: string;
  containerList?: Array<{
    cntrNo?: string;
    cntrTpszCd?: string;
    sealNo?: string;
    cntrStsCd?: string;
    eventList?: Array<{
      eventDt?: string;
      placeNm?: string;
      statusNm?: string;
      vslEngNm?: string;
      voyNo?: string;
    }>;
  }>;
  [key: string]: any;
}

async function trackONE(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking',
    responseUrlMatch: 'cargo-tracking',
    timeout: 45000,
    initialDelay: 4000,
    cookieDismissSelector: '.cookie-accept-btn, #onetrust-accept-btn-handler',
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('#ctrack, input[name="searchText"], input[placeholder*="B/L"], input[placeholder*="container"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('#searchbtn, button[type="submit"], .btn-search');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as ONEData | null;

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'ONE',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  if (json.blNo) result.blNo = json.blNo;
  if (json.pol) result.portOfLoading = json.pol;
  if (json.pod) result.portOfDischarge = json.pod;
  if (json.eta) result.eta = json.eta;
  if (json.vesselName) result.vesselVoyage = [json.vesselName, json.voyageNo].filter(Boolean).join(' / ');

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const c of json.containerList || []) {
    containers.push({
      containerNo: c.cntrNo || '',
      sizeType: c.cntrTpszCd || '',
      sealNo: c.sealNo || '',
      currentStatus: c.cntrStsCd || '',
    });

    for (const ev of c.eventList || []) {
      events.push({
        date: ev.eventDt || '',
        location: ev.placeNm || '',
        event: ev.statusNm || '',
        vesselVoyage: [ev.vslEngNm, ev.voyNo].filter(Boolean).join(' / '),
      });
    }
  }

  result.containers = containers;
  result.events = events;

  if (containers.length === 0 && events.length === 0 && !result.eta) return null;

  return result;
}

registry.register({
  id: 'one',
  displayName: 'ONE',
  track: trackONE,
});
