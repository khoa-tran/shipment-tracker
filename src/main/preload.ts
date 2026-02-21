import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  trackShipment: (trackingNumber: string, forceRefresh?: boolean) =>
    ipcRenderer.invoke('track-shipment', trackingNumber, forceRefresh),
  onTrackingStatus: (callback: (data: { carrierId: string; carrierName: string; status: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('tracking-status', listener);
    return () => ipcRenderer.removeListener('tracking-status', listener);
  },
  getCarriers: () =>
    ipcRenderer.invoke('get-carriers') as Promise<Array<{ id: string; displayName: string }>>,
  onCaptchaOverlay: (callback: (show: boolean) => void) => {
    const listener = (_event: any, show: boolean) => callback(show);
    ipcRenderer.on('captcha-overlay', listener);
    return () => ipcRenderer.removeListener('captcha-overlay', listener);
  },
});
