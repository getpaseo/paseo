import { contextBridge, ipcRenderer } from "electron";

type EventHandler = (payload: unknown) => void;
type BrowserFindAction = "clearSelection" | "keepSelection" | "activateSelection";

interface BrowserFoundInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`paseo:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`paseo:event:${event}`, listener);
      });
    },
  },
  window: {
    getCurrentWindow: () => ({
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
      }) => ipcRenderer.invoke("paseo:window:updateWindowControls", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("paseo:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("paseo:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("paseo:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:ask", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("paseo:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("paseo:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("paseo:opener:openUrl", url),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
  },
  browser: {
    setActivePane: (browserId: string | null) =>
      ipcRenderer.invoke("paseo:browser:set-active-pane", browserId),
    findInPage: (
      browserId: string,
      text: string,
      options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
    ) => ipcRenderer.invoke("paseo:browser:find-in-page", browserId, text, options),
    stopFindInPage: (browserId: string, action: BrowserFindAction) =>
      ipcRenderer.invoke("paseo:browser:stop-find-in-page", browserId, action),
    onFoundInPage: (
      browserId: string,
      listener: (result: BrowserFoundInPageResult) => void,
    ): (() => void) => {
      const ipcListener = (
        _ipcEvent: Electron.IpcRendererEvent,
        payload: BrowserFoundInPageResult & { browserId?: unknown },
      ) => {
        if (payload?.browserId !== browserId) {
          return;
        }
        const { browserId: _browserId, ...result } = payload;
        listener(result);
      };
      ipcRenderer.on("paseo:event:browser-found-in-page", ipcListener);
      return () => {
        ipcRenderer.removeListener("paseo:event:browser-found-in-page", ipcListener);
      };
    },
  },
});
