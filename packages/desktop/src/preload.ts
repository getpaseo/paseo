import { contextBridge, ipcRenderer } from "electron";

type EventHandler = (payload: unknown) => void;

contextBridge.exposeInMainWorld("hubcodeDesktop", {
  platform: process.platform,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("hubcode:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("hubcode:get-pending-open-project") as Promise<string | null>,
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`hubcode:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`hubcode:event:${event}`, listener);
      });
    },
  },
  window: {
    getCurrentWindow: () => ({
      toggleMaximize: () => ipcRenderer.invoke("hubcode:window:toggleMaximize"),
      isFullscreen: () => ipcRenderer.invoke("hubcode:window:isFullscreen"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
      }) => ipcRenderer.invoke("hubcode:window:updateWindowControls", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("hubcode:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("hubcode:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("hubcode:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("hubcode:dialog:ask", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("hubcode:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("hubcode:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("hubcode:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("hubcode:opener:openUrl", url),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("hubcode:menu:showContextMenu", input),
  },
});
