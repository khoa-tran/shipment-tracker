import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface MSCResponseData {
  IsSuccess?: boolean;
  Data?: {
    TrackingNumber?: string;
    BillOfLadings?: Array<{
      BillOfLadingNumber?: string;
      GeneralTrackingInfo?: {
        ShippedFrom?: string;
        PortOfLoad?: string;
        PortOfDischarge?: string;
        ShippedTo?: string;
        Transshipments?: string[];
      };
      ContainersInfo?: Array<{
        ContainerNumber?: string;
        ContainerType?: string;
        LatestMove?: string;
        PodEtaDate?: string;
        Events?: Array<{
          Order?: number;
          Date?: string;
          Location?: string;
          Description?: string;
          Detail?: string[];
          EquipmentHandling?: {
            Name?: string;
          };
        }>;
      }>;
    }>;
  };
}

export async function trackMSC(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: 'https://www.msc.com/en/track-a-shipment',
    responseUrlMatch: 'TrackingInfo',
    timeout: 45000,
    cookieDismissSelector: '#onetrust-accept-btn-handler',
    pageScript: (v) => `
      (function() {
        var input = document.querySelector('#trackingNumber');
        if (input) {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(function() {
          var btn = document.querySelector('.msc-flow-tracking__form .msc-search-autocomplete__search');
          if (btn) btn.click();
        }, 500);
      })();
    `,
  }, val, signal) as MSCResponseData | null;

  if (!json || !json.IsSuccess) return null;
  return parseMSCJson(json);
}

function parseMSCJson(data: MSCResponseData): TrackingResult | null {
  const d = data.Data;
  if (!d) return null;

  const bols = d.BillOfLadings;
  if (!bols || bols.length === 0) return null;

  const bol = bols[0];
  const gen = bol.GeneralTrackingInfo || {};

  const result: TrackingResult = {
    carrier: 'MSC',
    trackingNo: d.TrackingNumber,
    blNo: bol.BillOfLadingNumber,
    shippedFrom: gen.ShippedFrom,
    portOfLoading: gen.PortOfLoad,
    portOfDischarge: gen.PortOfDischarge,
    shippedTo: gen.ShippedTo,
    transshipments: gen.Transshipments?.join(', '),
    containers: [],
    events: [],
    planMoves: [],
  };

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const cntr of bol.ContainersInfo || []) {
    if (cntr.PodEtaDate) {
      result.eta = cntr.PodEtaDate;
    }

    containers.push({
      containerNo: cntr.ContainerNumber || '',
      sizeType: cntr.ContainerType || '',
      latestMove: cntr.LatestMove || '',
    });

    const sortedEvents = [...(cntr.Events || [])].sort(
      (a, b) => (a.Order || 0) - (b.Order || 0)
    );

    for (const ev of sortedEvents) {
      events.push({
        date: ev.Date || '',
        location: ev.Location || '',
        event: ev.Description || '',
        vesselVoyage: ev.Detail?.join(' / ') || '',
        terminal: ev.EquipmentHandling?.Name || '',
      });
    }
  }

  result.containers = containers;
  result.events = events;

  return result;
}

registry.register({
  id: 'msc',
  displayName: 'MSC',
  track: trackMSC,
});
