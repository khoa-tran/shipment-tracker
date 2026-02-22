export interface ContainerInfo {
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

export interface TrackingEvent {
  date: string;
  location: string;
  event: string;
  vesselVoyage?: string;
  terminal?: string;
  containerNo?: string;
}

export interface PlanMove {
  eta: string;
  location: string;
  vesselVoyage: string;
}

export interface TrackingResult {
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
  trackingUrl?: string;
  fetchedAt?: number;
}
