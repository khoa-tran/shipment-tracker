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

    const allCarriers = this.getAllCarriers();
    const controller = new AbortController();

    // OOCL requires CAPTCHA — run it last, only if no other carrier matched
    const DEFERRED_CARRIERS = ['oocl'];
    const primary = allCarriers.filter(c => !DEFERRED_CARRIERS.includes(c.id));
    const deferred = allCarriers.filter(c => DEFERRED_CARRIERS.includes(c.id));

    const runBatch = (carriers: CarrierDefinition[]): Promise<TrackingResult | null> => {
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
    };

    // Run primary carriers in parallel first
    const primaryResult = await runBatch(primary);
    if (primaryResult || controller.signal.aborted || deferred.length === 0) {
      return primaryResult;
    }

    // If no result, run deferred carriers (OOCL) sequentially
    return runBatch(deferred);
  }
}

export const registry = new CarrierRegistry();
