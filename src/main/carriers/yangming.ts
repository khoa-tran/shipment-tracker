import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

async function trackYangMing(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  // Yang Ming is ASP.NET — use CDP to handle VIEWSTATE complexity
  const json = await cdpTrack({
    url: 'https://www.yangming.com/e-service/Track_Trace/track_trace_cargo_tracking.aspx',
    responseUrlMatch: 'track_trace',
    timeout: 45000,
    initialDelay: 4000,
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('#ContentPlaceHolder1_txtBLNo, #ContentPlaceHolder1_txtCNTRNo, input[id*="txtBL"], input[id*="txtCNTR"]');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('#ContentPlaceHolder1_btnTrack, input[id*="btnTrack"], button[id*="btnTrack"]');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal);

  if (!json) return null;

  const result: TrackingResult = {
    carrier: 'Yang Ming',
    trackingNo: val,
    containers: [],
    events: [],
    planMoves: [],
  };

  // Parse the JSON response based on Yang Ming's API structure
  if (typeof json === 'object') {
    const data = json.d || json.Data || json;

    if (data.BLNo || data.blNo) result.blNo = data.BLNo || data.blNo;
    if (data.POL || data.portOfLoading) result.portOfLoading = data.POL || data.portOfLoading;
    if (data.POD || data.portOfDischarge) result.portOfDischarge = data.POD || data.portOfDischarge;
    if (data.ETA || data.eta) result.eta = data.ETA || data.eta;
    if (data.VesselVoyage) result.vesselVoyage = data.VesselVoyage;

    const containers = data.ContainerList || data.containers || [];
    for (const c of containers) {
      result.containers.push({
        containerNo: c.ContainerNo || c.cntrNo || '',
        sizeType: c.ContainerType || c.cntrType || '',
        currentStatus: c.Status || c.status || '',
      });
    }

    const events = data.EventList || data.events || [];
    for (const ev of events) {
      result.events.push({
        date: ev.Date || ev.date || '',
        location: ev.Location || ev.location || '',
        event: ev.Description || ev.description || ev.Status || '',
        vesselVoyage: ev.VesselVoyage || ev.vessel || '',
      });
    }
  }

  if (result.containers.length === 0 && result.events.length === 0 && !result.eta) return null;

  return result;
}

registry.register({
  id: 'yangming',
  displayName: 'Yang Ming',
  track: trackYangMing,
});
