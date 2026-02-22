interface ContainerInfo {
  containerNo: string;
  sizeType: string;
  sealNo?: string;
  serviceType?: string;
  quantity?: string;
  vgm?: string;
  currentStatus?: string;
  date?: string;
  location?: string;
  vesselVoyage?: string;
  latestMove?: string;
}

interface TrackingEvent {
  date: string;
  location: string;
  event: string;
  vesselVoyage?: string;
  terminal?: string;
  containerNo?: string;
}

interface PlanMove {
  eta: string;
  location: string;
  vesselVoyage: string;
}

interface TrackingResult {
  carrier: string;
  trackingNo?: string;
  blNo?: string;
  vesselVoyage?: string;
  eta?: string;
  placeOfReceipt?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  placeOfDelivery?: string;
  shippedFrom?: string;
  shippedTo?: string;
  transshipments?: string;
  containerCount?: string;
  grossWeight?: string;
  measurement?: string;
  manifestQuantity?: string;
  onBoardDate?: string;
  serviceMode?: string;
  containers: ContainerInfo[];
  events: TrackingEvent[];
  planMoves: PlanMove[];
}

interface TrackingStatusEvent {
  carrierId: string;
  carrierName: string;
  status: 'searching' | 'found' | 'no-result' | 'error';
}

declare global {
  interface Window {
    electronAPI: {
      trackShipment: (trackingNumber: string, forceRefresh?: boolean) => Promise<TrackingResult>;
      onTrackingStatus: (callback: (data: TrackingStatusEvent) => void) => () => void;
      getCarriers: () => Promise<Array<{ id: string; displayName: string }>>;
      onCaptchaOverlay: (callback: (show: boolean) => void) => () => void;
    };
  }
}

// --- State ---

interface TrackedShipment {
  id: string;
  inputNumber: string;
  result: TrackingResult;
  etaDate: Date | null;
  addedAt: number;
  fetchedAt: number;
}

let shipments: TrackedShipment[] = [];
const expandedIds = new Set<string>();

// --- DOM refs ---

const trackingInput = document.getElementById('trackingInput') as HTMLTextAreaElement;
const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading')!;
const loadingText = document.getElementById('loadingText')!;
const progressEl = document.getElementById('progress')!;
const progressText = document.getElementById('progressText')!;
const progressBar = document.getElementById('progressBar')!;
const errorEl = document.getElementById('error')!;
const resultsEl = document.getElementById('results')!;

// --- Date normalization ---

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();

  // Evergreen: MAR-15-2026
  const evMatch = s.match(/^([A-Z]{3})-(\d{2})-(\d{4})$/);
  if (evMatch && MONTH_MAP[evMatch[1]] !== undefined) {
    return new Date(parseInt(evMatch[3]), MONTH_MAP[evMatch[1]], parseInt(evMatch[2]));
  }

  // DD/MM/YYYY (MSC)
  const slashMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    return new Date(parseInt(slashMatch[3]), parseInt(slashMatch[2]) - 1, parseInt(slashMatch[1]));
  }

  // ISO: 2026-03-15 or 2026-03-15T00:00:00
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  // Fallback: let JS try
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  return null;
}

function formatDate(raw: string | undefined): string {
  if (!raw) return '';
  const d = parseDate(raw);
  if (!d) return raw; // can't parse, return as-is
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// --- Helpers ---

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function parseInputNumbers(text: string): string[] {
  return text
    .split(/[,\n\r]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0);
}

function sortShipments(): void {
  shipments.sort((a, b) => {
    if (a.etaDate && b.etaDate) return a.etaDate.getTime() - b.etaDate.getTime();
    if (a.etaDate && !b.etaDate) return -1;
    if (!a.etaDate && b.etaDate) return 1;
    return a.addedAt - b.addedAt;
  });
}

function getShipmentId(result: TrackingResult, inputNumber: string): string {
  return result.blNo || result.trackingNo || inputNumber;
}

function getOrigin(r: TrackingResult): string {
  return r.portOfLoading || r.placeOfReceipt || r.shippedFrom || '';
}

function getDestination(r: TrackingResult): string {
  return r.portOfDischarge || r.placeOfDelivery || r.shippedTo || '';
}

function getSealNumbers(r: TrackingResult): string[] {
  // Collect known B/L and tracking numbers to filter out false seal matches
  const excludes = new Set<string>();
  if (r.blNo) excludes.add(r.blNo.toUpperCase());
  if (r.trackingNo) excludes.add(r.trackingNo.toUpperCase());

  const seals: string[] = [];
  for (const c of r.containers) {
    if (c.sealNo) {
      for (const s of c.sealNo.split(/[,;]+/)) {
        const trimmed = s.trim();
        if (trimmed && !seals.includes(trimmed) && !excludes.has(trimmed.toUpperCase())) {
          seals.push(trimmed);
        }
      }
    }
  }
  return seals;
}

function getVesselVoyage(r: TrackingResult): string {
  if (r.vesselVoyage) return r.vesselVoyage;
  for (const c of r.containers) {
    if (c.vesselVoyage) return c.vesselVoyage;
  }
  return '';
}

function getContainerCount(r: TrackingResult): string {
  if (r.containerCount) return r.containerCount;
  if (r.containers.length > 0) return String(r.containers.length);
  return '';
}

// Find an existing shipment that shares a container number with the new result
function findOverlappingShipment(result: TrackingResult): number {
  const newContainers = new Set(result.containers.map(c => c.containerNo).filter(Boolean));
  if (newContainers.size === 0) return -1;

  for (let i = 0; i < shipments.length; i++) {
    for (const c of shipments[i].result.containers) {
      if (c.containerNo && newContainers.has(c.containerNo)) return i;
    }
  }
  return -1;
}

// Merge two TrackingResults: prefer the one with more data, fill in gaps from the other
function mergeResults(existing: TrackingResult, incoming: TrackingResult): TrackingResult {
  // Use whichever has richer shipment details (B/L search is usually richer)
  const existingScore = [existing.blNo, existing.portOfLoading, existing.placeOfReceipt, existing.portOfDischarge, existing.placeOfDelivery].filter(Boolean).length;
  const incomingScore = [incoming.blNo, incoming.portOfLoading, incoming.placeOfReceipt, incoming.portOfDischarge, incoming.placeOfDelivery].filter(Boolean).length;

  const base = existingScore >= incomingScore ? existing : incoming;
  const other = base === existing ? incoming : existing;

  // Merge: use base as the primary, fill missing fields from other
  const merged: TrackingResult = { ...base };

  // Fill missing top-level string fields from other
  const fields: (keyof TrackingResult)[] = [
    'trackingNo', 'blNo', 'vesselVoyage', 'eta',
    'placeOfReceipt', 'portOfLoading', 'portOfDischarge', 'placeOfDelivery',
    'shippedFrom', 'shippedTo', 'transshipments', 'containerCount',
    'grossWeight', 'measurement', 'manifestQuantity', 'onBoardDate', 'serviceMode',
  ];
  for (const f of fields) {
    if (!merged[f] && other[f]) {
      (merged as any)[f] = other[f];
    }
  }

  // Merge containers: union by containerNo, enrich with seal info
  const containerMap = new Map<string, ContainerInfo>();
  for (const c of other.containers) {
    if (c.containerNo) containerMap.set(c.containerNo, { ...c });
  }
  for (const c of base.containers) {
    if (c.containerNo) {
      const existing = containerMap.get(c.containerNo);
      if (existing) {
        // Merge: prefer base fields, fill from other
        containerMap.set(c.containerNo, {
          ...existing,
          ...Object.fromEntries(Object.entries(c).filter(([, v]) => v)),
        });
      } else {
        containerMap.set(c.containerNo, { ...c });
      }
    }
  }
  merged.containers = Array.from(containerMap.values());

  // Use the longer events/planMoves list
  if (other.events.length > merged.events.length) merged.events = other.events;
  if (other.planMoves.length > merged.planMoves.length) merged.planMoves = other.planMoves;

  return merged;
}

// --- UI State ---

function showProgress(current: number, total: number): void {
  progressText.textContent = `Tracking ${current} of ${total}...`;
  progressBar.style.width = `${(current / total) * 100}%`;
  progressEl.classList.remove('hidden');
}

function hideProgress(): void {
  progressEl.classList.add('hidden');
}

function showResults(): void {
  resultsEl.classList.toggle('hidden', shipments.length === 0);
}

// --- Carrier Status ---

const carrierStatusEl = document.getElementById('carrierStatus')!;
let removeStatusListener: (() => void) | null = null;

function setupStatusListener(): void {
  if (removeStatusListener) removeStatusListener();
  carrierStatusEl.innerHTML = '';
  removeStatusListener = window.electronAPI.onTrackingStatus((data) => {
    const existing = document.getElementById(`cs-${data.carrierId}`);
    if (data.status === 'searching') {
      if (existing) return;
      const row = document.createElement('div');
      row.className = 'carrier-status-row';
      row.id = `cs-${data.carrierId}`;
      row.innerHTML =
        `<span class="cs-icon cs-searching"></span>` +
        `<span class="cs-name">${escapeHtml(data.carrierName)}</span>` +
        `<span class="cs-label">searching</span>`;
      carrierStatusEl.appendChild(row);
    } else if (existing) {
      const icon = existing.querySelector('.cs-icon')!;
      const label = existing.querySelector('.cs-label')!;
      if (data.status === 'found') {
        icon.className = 'cs-icon cs-found';
        icon.textContent = '\u2714';
        label.textContent = 'found';
        // Mark all still-searching rows as done (they'll be aborted)
        for (const row of carrierStatusEl.querySelectorAll('.carrier-status-row:not(.cs-done)')) {
          if (row.id === existing.id) continue;
          const rIcon = row.querySelector('.cs-icon')!;
          const rLabel = row.querySelector('.cs-label')!;
          if (rIcon.classList.contains('cs-searching')) {
            rIcon.className = 'cs-icon cs-no-result';
            rIcon.textContent = '\u2013';
            rLabel.textContent = '';
            row.classList.add('cs-done');
          }
        }
      } else if (data.status === 'error') {
        icon.className = 'cs-icon cs-error';
        icon.textContent = '\u2717';
        label.textContent = 'error';
        existing.classList.add('cs-done');
      } else {
        icon.className = 'cs-icon cs-no-result';
        icon.textContent = '\u2013';
        label.textContent = '';
        existing.classList.add('cs-done');
      }
    }
  });
}

function teardownStatusListener(): void {
  if (removeStatusListener) {
    removeStatusListener();
    removeStatusListener = null;
  }
}

// --- Search ---

let searchCancelled = false;
let isSearching = false;
let searchGeneration = 0;

function setSearchingState(searching: boolean): void {
  isSearching = searching;
  searchBtn.textContent = searching ? 'CANCEL' : 'TRACK';
  searchBtn.classList.toggle('cancel-mode', searching);
}

function cancelSearch(): void {
  searchCancelled = true;
  searchGeneration++;
  loadingEl.classList.add('hidden');
  hideProgress();
  setSearchingState(false);
  teardownStatusListener();
}

async function doSearch(): Promise<void> {
  // If already searching, cancel
  if (isSearching) {
    cancelSearch();
    return;
  }

  const numbers = parseInputNumbers(trackingInput.value);
  if (numbers.length === 0) {
    trackingInput.focus();
    return;
  }

  // Clear previous results
  shipments = [];
  expandedIds.clear();
  resultsEl.innerHTML = '';
  resultsEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  searchCancelled = false;
  const thisGeneration = ++searchGeneration;
  setSearchingState(true);

  const errors: string[] = [];
  const total = numbers.length;

  function handleResult(num: string, result: TrackingResult): void {
    const id = getShipmentId(result, num);

    // Check for exact ID match first, then container overlap
    let existingIdx = shipments.findIndex(s => s.id === id);
    if (existingIdx < 0) {
      existingIdx = findOverlappingShipment(result);
    }

    let mergedResult = result;
    let mergedId = id;

    if (existingIdx >= 0) {
      mergedResult = mergeResults(shipments[existingIdx].result, result);
      mergedId = mergedResult.blNo || shipments[existingIdx].id;
    }

    const entry: TrackedShipment = {
      id: mergedId,
      inputNumber: num,
      result: mergedResult,
      etaDate: parseDate(mergedResult.eta),
      addedAt: existingIdx >= 0 ? shipments[existingIdx].addedAt : Date.now(),
      fetchedAt: mergedResult.fetchedAt || Date.now(),
    };

    if (existingIdx >= 0) {
      shipments[existingIdx] = entry;
    } else {
      shipments.push(entry);
    }

    sortShipments();
    renderShipmentList();
    showResults();
  }

  if (total === 1) {
    // Single input: show carrier-level status
    loadingText.textContent = `Searching for ${numbers[0]}...`;
    loadingEl.classList.remove('hidden');

    for (let attempt = 0; attempt < 2; attempt++) {
      if (searchCancelled || thisGeneration !== searchGeneration) break;
      try {
        const result = await window.electronAPI.trackShipment(numbers[0]);
        if (!searchCancelled && thisGeneration === searchGeneration) {
          handleResult(numbers[0], result);
        }
        break;
      } catch (err: any) {
        if (attempt === 0 && !searchCancelled && thisGeneration === searchGeneration) {
          await new Promise(r => setTimeout(r, 2000));
        } else if (!searchCancelled && thisGeneration === searchGeneration) {
          errors.push(`${numbers[0]} — ${err.message || 'Unknown error'}`);
        }
      }
    }
  } else {
    // Multiple inputs: run in parallel with concurrency limit
    const MAX_CONCURRENT = 2;
    let completed = 0;
    showProgress(0, total);
    loadingText.textContent = `Searching ${total} tracking numbers...`;
    loadingEl.classList.remove('hidden');

    async function processOne(num: string): Promise<void> {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (searchCancelled || thisGeneration !== searchGeneration) return;
          try {
            const result = await window.electronAPI.trackShipment(num);
            if (searchCancelled || thisGeneration !== searchGeneration) return;
            handleResult(num, result);
            return;
          } catch (err: any) {
            if (attempt === 0 && !searchCancelled && thisGeneration === searchGeneration) {
              await new Promise(r => setTimeout(r, 2000));
            } else {
              throw err;
            }
          }
        }
      } catch (err: any) {
        if (!searchCancelled && thisGeneration === searchGeneration) {
          errors.push(`${num} — ${err.message || 'Unknown error'}`);
        }
      } finally {
        completed++;
        if (thisGeneration === searchGeneration && !searchCancelled) {
          showProgress(completed, total);
        }
      }
    }

    const queue = [...numbers];
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT, queue.length) },
      async () => {
        while (queue.length > 0 && !searchCancelled && thisGeneration === searchGeneration) {
          const num = queue.shift()!;
          await processOne(num);
        }
      }
    );

    await Promise.all(workers);
  }

  // Only update UI if this search is still the active one
  if (thisGeneration !== searchGeneration) return;
  loadingEl.classList.add('hidden');
  hideProgress();
  setSearchingState(false);
  teardownStatusListener();
  if (errors.length > 0) {
    errorEl.textContent = errors.length === 1
      ? errors[0]
      : `${errors.length} errors:\n${errors.join('\n')}`;
    errorEl.classList.remove('hidden');
  }

  trackingInput.focus();
}

// --- Rendering ---

function renderShipmentList(): void {
  let html = '<div class="shipment-list-header">';
  html += `<span class="shipment-count">${shipments.length} shipment${shipments.length !== 1 ? 's' : ''} tracked</span>`;
  html += '<button class="clear-all-btn" id="clearAllBtn">CLEAR ALL</button>';
  html += '</div>';

  // Column header row
  html += '<div class="row-header">';
  html += '<div class="col-carrier">Carrier</div>';
  html += '<div class="col-number">B/L #</div>';
  html += '<div class="col-origin">Origin</div>';
  html += '<div class="col-dest">Destination</div>';
  html += '<div class="col-vessel">Vessel / Voyage</div>';
  html += '<div class="col-eta">ETA</div>';
  html += '<div class="col-cntrs">Ctrs</div>';
  html += '<div class="col-seal">Seal No.</div>';
  html += '<div class="col-freshness">Updated</div>';
  html += '<div class="col-actions"></div>';
  html += '</div>';

  // Rows
  html += '<div class="shipment-rows">';
  for (const s of shipments) {
    html += renderShipmentRow(s);
  }
  html += '</div>';

  resultsEl.innerHTML = html;

  // Attach event listeners
  document.getElementById('clearAllBtn')?.addEventListener('click', () => {
    shipments = [];
    expandedIds.clear();
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');
    errorEl.classList.add('hidden');
  });

  for (const s of shipments) {
    const safeId = CSS.escape(s.id);
    // Click anywhere on the row to expand/collapse
    document.querySelector(`[data-row="${safeId}"]`)?.addEventListener('click', (e) => {
      // Don't toggle if clicking an action button
      if ((e.target as HTMLElement).closest('.col-actions')) return;
      if (expandedIds.has(s.id)) {
        expandedIds.delete(s.id);
      } else {
        expandedIds.add(s.id);
      }
      renderShipmentList();
      showResults();
    });

    document.querySelector(`[data-refresh="${safeId}"]`)?.addEventListener('click', async () => {
      const btn = document.querySelector(`[data-refresh="${safeId}"]`) as HTMLButtonElement | null;
      if (btn) { btn.disabled = true; btn.classList.add('refreshing'); }
      try {
        const result = await window.electronAPI.trackShipment(s.inputNumber, true);
        const idx = shipments.findIndex(sh => sh.id === s.id);
        if (idx >= 0) {
          shipments[idx] = {
            ...shipments[idx],
            result,
            etaDate: parseDate(result.eta),
            fetchedAt: result.fetchedAt || Date.now(),
          };
          sortShipments();
          renderShipmentList();
          showResults();
        }
      } catch {
        // Refresh failed — keep existing data
        if (btn) { btn.disabled = false; btn.classList.remove('refreshing'); }
      }
    });

    document.querySelector(`[data-remove="${safeId}"]`)?.addEventListener('click', () => {
      const idx = shipments.findIndex(sh => sh.id === s.id);
      if (idx >= 0) shipments.splice(idx, 1);
      expandedIds.delete(s.id);
      if (shipments.length === 0) {
        resultsEl.innerHTML = '';
        resultsEl.classList.add('hidden');
      } else {
        renderShipmentList();
      }
    });
  }

  // Container expand/collapse handlers
  for (const header of document.querySelectorAll('.container-header[data-container]')) {
    header.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't bubble to shipment row
      const cntrNo = (header as HTMLElement).dataset.container!;
      const key = 'ctr:' + cntrNo;
      if (expandedIds.has(key)) {
        expandedIds.delete(key);
      } else {
        expandedIds.add(key);
      }
      renderShipmentList();
      showResults();
    });
  }
}

function renderShipmentRow(s: TrackedShipment): string {
  const r = s.result;
  const origin = getOrigin(r);
  const destination = getDestination(r);
  const seals = getSealNumbers(r);
  const displayNumber = r.blNo || r.trackingNo || s.id;
  const isExpanded = expandedIds.has(s.id);
  const safeId = escapeHtml(s.id);
  const vessel = getVesselVoyage(r);
  const ctrCount = getContainerCount(r);
  const formattedEta = formatDate(r.eta);

  let html = `<div class="shipment-row${isExpanded ? ' expanded' : ''}">`;

  // Main columns
  html += `<div class="shipment-row-main" data-row="${safeId}">`;
  html += `<div class="col-carrier">${escapeHtml(r.carrier)}</div>`;
  html += `<div class="col-number"><span class="tracking-num">${escapeHtml(displayNumber)}</span></div>`;
  html += `<div class="col-origin">${origin ? escapeHtml(origin) : '<span class="muted">\u2014</span>'}</div>`;
  html += `<div class="col-dest">${destination ? escapeHtml(destination) : '<span class="muted">\u2014</span>'}</div>`;
  html += `<div class="col-vessel">${vessel ? escapeHtml(vessel) : '<span class="muted">\u2014</span>'}</div>`;
  html += `<div class="col-eta">${formattedEta ? escapeHtml(formattedEta) : '<span class="muted">\u2014</span>'}</div>`;
  html += `<div class="col-cntrs">${ctrCount ? escapeHtml(ctrCount) : '<span class="muted">\u2014</span>'}</div>`;
  html += `<div class="col-seal">${seals.length > 0 ? seals.map(seal => escapeHtml(seal)).join(', ') : '<span class="muted">\u2014</span>'}</div>`;

  html += `<div class="col-freshness"><span class="freshness-text">${timeAgo(s.fetchedAt)}</span></div>`;
  html += `<div class="col-actions">`;
  html += `<button class="icon-btn refresh-btn" data-refresh="${safeId}" title="Refresh">\u21BB</button>`;
  html += `<button class="icon-btn remove-btn" data-remove="${safeId}" title="Remove">\u2715</button>`;
  html += `</div>`;
  html += `</div>`; // .shipment-row-main

  // Expanded details
  if (isExpanded) {
    html += `<div class="row-details">`;
    html += renderDetailSection(r);
    html += `</div>`;
  }

  html += `</div>`; // .shipment-row
  return html;
}

function renderDetailSection(r: TrackingResult): string {
  let html = '';

  // Details grid
  const details: [string, string | undefined][] = [
    ['Carrier', r.carrier],
    ['Tracking No.', r.trackingNo],
    ['B/L No.', r.blNo],
    ['Vessel / Voyage', r.vesselVoyage],
    ['ETA', formatDate(r.eta) || undefined],
    ['Place of Receipt', r.placeOfReceipt],
    ['Port of Loading', r.portOfLoading],
    ['Port of Discharge', r.portOfDischarge],
    ['Place of Delivery', r.placeOfDelivery],
    ['Shipped From', r.shippedFrom],
    ['Shipped To', r.shippedTo],
    ['Transshipments', r.transshipments],
    ['Container Count', r.containerCount],
    ['Gross Weight', r.grossWeight],
    ['Measurement', r.measurement],
    ['Manifest Quantity', r.manifestQuantity],
    ['On Board Date', formatDate(r.onBoardDate) || undefined],
    ['Service Mode', r.serviceMode],
  ];

  const filteredDetails = details.filter(([, val]) => val);
  if (filteredDetails.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Shipment Details</div>';
    html += '<div class="details-grid">';
    for (const [label, val] of filteredDetails) {
      html += `<span class="detail-label">${escapeHtml(label)}</span>`;
      html += `<span class="detail-value">${escapeHtml(val!)}</span>`;
    }
    html += '</div></div>';
  }

  // Group events by containerNo
  const eventsByContainer = new Map<string, TrackingEvent[]>();
  const shipmentEvents: TrackingEvent[] = [];
  for (const ev of r.events) {
    if (ev.containerNo) {
      const list = eventsByContainer.get(ev.containerNo) || [];
      list.push(ev);
      eventsByContainer.set(ev.containerNo, list);
    } else {
      shipmentEvents.push(ev);
    }
  }

  // Containers as expandable cards
  if (r.containers.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Containers</div>';

    for (const c of r.containers) {
      const hasEvents = eventsByContainer.has(c.containerNo);
      const ctrKey = 'ctr:' + c.containerNo;
      const isExpanded = hasEvents && expandedIds.has(ctrKey);

      html += `<div class="container-card${isExpanded ? ' expanded' : ''}">`;
      html += `<div class="container-header"${hasEvents ? ` data-container="${escapeHtml(c.containerNo)}"` : ''}>`;

      // Toggle arrow (only if events exist)
      if (hasEvents) {
        html += `<span class="container-toggle">\u25B6</span>`;
      }

      html += `<span class="mono">${escapeHtml(c.containerNo)}</span>`;
      if (c.sizeType) html += `<span class="container-detail">${escapeHtml(c.sizeType)}</span>`;
      if (c.sealNo) html += `<span class="container-detail seal-cell">${escapeHtml(c.sealNo)}</span>`;
      if (c.currentStatus) html += `<span class="container-status">${escapeHtml(c.currentStatus)}</span>`;
      if (c.date) html += `<span class="container-detail">${escapeHtml(formatDate(c.date) || c.date)}</span>`;
      if (c.location) html += `<span class="container-detail">${escapeHtml(c.location)}</span>`;

      html += '</div>'; // .container-header

      // Expanded event table
      if (isExpanded) {
        const events = eventsByContainer.get(c.containerNo)!;
        html += '<div class="container-events">';
        html += '<table class="data-table"><thead><tr>';
        html += '<th>Date</th><th>Event</th><th>Location</th>';
        html += '</tr></thead><tbody>';
        for (const ev of events) {
          let loc = ev.location;
          if (ev.vesselVoyage) loc += ` [${ev.vesselVoyage}]`;
          if (ev.terminal) loc += ` @ ${ev.terminal}`;

          html += '<tr>';
          html += `<td class="nowrap">${escapeHtml(formatDate(ev.date) || ev.date)}</td>`;
          html += `<td>${escapeHtml(ev.event)}</td>`;
          html += `<td>${escapeHtml(loc)}</td>`;
          html += '</tr>';
        }
        html += '</tbody></table></div>'; // .container-events
      }

      html += '</div>'; // .container-card
    }

    html += '</div>'; // .detail-section
  }

  // Shipment Events fallback (events without containerNo)
  if (shipmentEvents.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Shipment Events</div>';
    html += '<table class="data-table"><thead><tr>';
    html += '<th>Date</th><th>Event</th><th>Location</th>';
    html += '</tr></thead><tbody>';
    for (const ev of shipmentEvents) {
      let loc = ev.location;
      if (ev.vesselVoyage) loc += ` [${ev.vesselVoyage}]`;
      if (ev.terminal) loc += ` @ ${ev.terminal}`;

      html += '<tr>';
      html += `<td class="nowrap">${escapeHtml(formatDate(ev.date) || ev.date)}</td>`;
      html += `<td>${escapeHtml(ev.event)}</td>`;
      html += `<td>${escapeHtml(loc)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  // Plan Moves
  if (r.planMoves.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Planned Moves</div>';
    html += '<table class="data-table"><thead><tr>';
    html += '<th>ETA</th><th>Location</th><th>Vessel/Voyage</th>';
    html += '</tr></thead><tbody>';
    for (const pm of r.planMoves) {
      html += '<tr>';
      html += `<td class="nowrap">${escapeHtml(formatDate(pm.eta) || pm.eta)}</td>`;
      html += `<td>${escapeHtml(pm.location)}</td>`;
      html += `<td>${escapeHtml(pm.vesselVoyage)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  return html;
}

// --- Event Listeners ---

searchBtn.addEventListener('click', doSearch);

// --- CAPTCHA Overlay ---

const captchaOverlay = document.getElementById('captchaOverlay')!;
window.electronAPI.onCaptchaOverlay((show) => {
  captchaOverlay.classList.toggle('hidden', !show);
});

trackingInput.focus();
