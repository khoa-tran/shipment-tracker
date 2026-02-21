import { TrackingResult } from './types';

export type TrackingStatus = 'searching' | 'found' | 'no-result' | 'error';
export type ProgressCallback = (carrierId: string, carrierName: string, status: TrackingStatus) => void;

export interface CarrierDefinition {
  id: string;
  displayName: string;
  track(value: string, signal?: AbortSignal): Promise<TrackingResult | null>;
}

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  result: TrackingResult;
  timestamp: number;
}

class CarrierRegistry {
  private carriers = new Map<string, CarrierDefinition>();
  private cache = new Map<string, CacheEntry>();

  register(carrier: CarrierDefinition): void {
    this.carriers.set(carrier.id, carrier);
  }

  getCarrier(id: string): CarrierDefinition | undefined {
    return this.carriers.get(id);
  }

  getAllCarriers(): CarrierDefinition[] {
    return Array.from(this.carriers.values());
  }

  async trackAll(value: string, onProgress?: ProgressCallback, forceRefresh?: boolean): Promise<TrackingResult | null> {
    // Check cache first
    if (!forceRefresh) {
      const cached = this.cache.get(value);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { ...cached.result, fetchedAt: cached.timestamp };
      }
    }

    const carriers = this.getAllCarriers();
    const controller = new AbortController();

    return new Promise((resolve) => {
      let pending = carriers.length;
      let found = false;

      for (const carrier of carriers) {
        onProgress?.(carrier.id, carrier.displayName, 'searching');

        carrier.track(value, controller.signal)
          .then((result) => {
            if (found) return;
            if (result) {
              found = true;
              const now = Date.now();
              result.fetchedAt = now;
              this.cache.set(value, { result, timestamp: now });
              onProgress?.(carrier.id, carrier.displayName, 'found');
              controller.abort();
              resolve(result);
            } else {
              onProgress?.(carrier.id, carrier.displayName, 'no-result');
            }
          })
          .catch(() => {
            if (!found) {
              onProgress?.(carrier.id, carrier.displayName, 'error');
            }
          })
          .finally(() => {
            pending--;
            if (pending === 0 && !found) {
              resolve(null);
            }
          });
      }
    });
  }
}

export const registry = new CarrierRegistry();
