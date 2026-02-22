import { ipcMain, shell } from 'electron';
import { registry } from './carriers';
import { TrackingResult } from './carriers/types';

export function registerIpcHandlers(): void {
  ipcMain.handle('track-shipment', async (event, trackingNumber: string, forceRefresh?: boolean): Promise<TrackingResult> => {
    const val = trackingNumber.trim().toUpperCase();
    if (!val) {
      throw new Error('Please enter a tracking number.');
    }

    const result = await registry.trackAll(val, (carrierId, carrierName, status) => {
      event.sender.send('tracking-status', { carrierId, carrierName, status });
    }, forceRefresh);

    if (!result) {
      throw new Error(
        `No tracking results found for "${val}".\n` +
        'Please check your tracking number and try again.'
      );
    }

    return result;
  });

  ipcMain.handle('get-carriers', () => {
    return registry.getAllCarriers().map(c => ({ id: c.id, displayName: c.displayName }));
  });

  ipcMain.handle('open-external', (_event, url: string) => {
    return shell.openExternal(url);
  });
}
