import { TrackingResult, ContainerInfo, TrackingEvent } from './types';
import { registry } from './registry';
import { cdpTrack } from './helpers';

interface MaerskLocation {
  terminal?: string;
  city?: string;
  state?: string | null;
  country?: string;
  country_code?: string;
  site_type?: string;
  location_code?: string;
  events?: MaerskEvent[];
}

interface MaerskEvent {
  type?: string;
  eventId?: string;
  locationCode?: string;
  activity?: string;
  stempty?: boolean;
  actfor?: string;
  event_time?: string;
  event_time_type?: string;
  vessel_name?: string;
  voyage?: string;
}

interface MaerskContainer {
  container_num?: string;
  container_size?: string;
  container_type?: string;
  iso_code?: string;
  shipment_num?: string;
  operator?: string;
  locations?: MaerskLocation[];
}

interface MaerskData {
  date_time?: string;
  origin?: {
    terminal?: string;
    city?: string;
    country?: string;
    country_code?: string;
    location_code?: string;
  };
  destination?: {
    terminal?: string;
    city?: string;
    country?: string;
    country_code?: string;
    location_code?: string;
  };
  containers?: MaerskContainer[];
}

async function trackMaersk(searchValue: string, signal?: AbortSignal): Promise<TrackingResult | null> {
  const val = searchValue.trim().toUpperCase();

  const json = await cdpTrack({
    url: 'https://www.maersk.com/tracking/',
    responseUrlMatch: '',
    timeout: 45000,
    initialDelay: 3000,
    cookieDismissSelector: '#coiPage-1 .coi-banner__accept',
    responseValidator: (json) => json != null && Array.isArray(json.containers),
    pageScript: (v) => `
      (function() {
        var select = document.querySelector('select');
        if (select) {
          for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].text.toLowerCase().includes('ocean')) {
              select.selectedIndex = i;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }

        var input = document.querySelector('input[type="text"], input[type="search"]');
        if (input) {
          var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(input, '${v}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        setTimeout(function() {
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent.trim() === 'Track') {
              btns[i].click();
              break;
            }
          }
        }, 500);
      })()
    `,
  }, val, signal) as MaerskData | null;

  if (!json) return null;
  return parseMaerskJson(json, val);
}

function parseMaerskJson(data: MaerskData, trackingNo: string): TrackingResult | null {
  const cntrList = data.containers;
  if (!cntrList || cntrList.length === 0) return null;

  const result: TrackingResult = {
    carrier: 'Maersk',
    trackingNo,
    blNo: cntrList[0]?.shipment_num,
    containers: [],
    events: [],
    planMoves: [],
  };

  if (data.origin) {
    result.portOfLoading = [data.origin.city, data.origin.country].filter(Boolean).join(', ');
  }
  if (data.destination) {
    result.portOfDischarge = [data.destination.city, data.destination.country].filter(Boolean).join(', ');
  }

  const containers: ContainerInfo[] = [];
  const events: TrackingEvent[] = [];

  for (const cntr of cntrList) {
    const sizeType = [cntr.container_size, cntr.container_type, cntr.iso_code]
      .filter(Boolean).join(' / ');

    let latestMove = '';
    let latestTime = '';

    for (const loc of cntr.locations || []) {
      for (const ev of loc.events || []) {
        const eventTime = ev.event_time || '';
        const location = [loc.city, loc.country].filter(Boolean).join(', ');

        events.push({
          date: eventTime,
          location,
          event: ev.activity || '',
          vesselVoyage: [ev.vessel_name, ev.voyage].filter(Boolean).join(' / '),
          terminal: loc.terminal || '',
        });

        // Track latest actual event
        if (ev.event_time_type === 'ACTUAL' && eventTime > latestTime) {
          latestTime = eventTime;
          latestMove = `${ev.activity || ''} - ${location}`;
        }

        // Use estimated arrival at destination as ETA
        if (ev.event_time_type === 'ESTIMATED' && ev.activity?.includes('DISCHARGE')) {
          result.eta = eventTime;
        }
      }
    }

    containers.push({
      containerNo: cntr.container_num || '',
      sizeType,
      latestMove,
    });
  }

  result.containers = containers;
  result.events = events;

  if (containers.length === 0 && events.length === 0) return null;

  return result;
}

registry.register({
  id: 'maersk',
  displayName: 'Maersk',
  track: trackMaersk,
});
