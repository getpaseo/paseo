import { contextBridge, ipcRenderer, webUtils } from "electron";

type EventHandler = (payload: unknown) => void;
type BrowserPixelCapturePrepareHandler = (input: {
  requestId: string;
  browserId: string;
}) => Promise<{ token: string }>;
type BrowserPixelCaptureRestoreHandler = (input: { token: string }) => Promise<void>;
type BrowserPixelCaptureCancelHandler = (input: {
  requestId?: string;
  token?: string;
}) => Promise<void>;

let prepareForPixelCaptureHandler: BrowserPixelCapturePrepareHandler | null = null;
let restorePixelCaptureHandler: BrowserPixelCaptureRestoreHandler | null = null;
let cancelPixelCaptureHandler: BrowserPixelCaptureCancelHandler | null = null;
const canceledPixelCaptureRequestIds = new Set<string>();

function readStringField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

ipcRenderer.on("paseo:browser:capture-prepare", async (_event, payload: unknown) => {
  const requestId = readStringField(payload, "requestId");
  const browserId = readStringField(payload, "browserId");
  if (!requestId || !browserId || !prepareForPixelCaptureHandler) {
    ipcRenderer.send("paseo:browser:capture-prepared", {
      requestId: requestId ?? "unknown",
      ok: false,
      message: "Browser pixel capture preparation is unavailable.",
    });
    return;
  }

  try {
    const preparation = await prepareForPixelCaptureHandler({ requestId, browserId });
    if (canceledPixelCaptureRequestIds.delete(requestId)) {
      await restorePixelCaptureHandler?.({ token: preparation.token });
      ipcRenderer.send("paseo:browser:capture-prepared", {
        requestId,
        ok: false,
        message: "Browser pixel capture preparation was canceled.",
      });
      return;
    }
    ipcRenderer.send("paseo:browser:capture-prepared", {
      requestId,
      ok: true,
      token: preparation.token,
    });
  } catch (error) {
    canceledPixelCaptureRequestIds.delete(requestId);
    ipcRenderer.send("paseo:browser:capture-prepared", {
      requestId,
      ok: false,
      message: errorMessage(error),
    });
  }
});

ipcRenderer.on("paseo:browser:capture-cancel", async (_event, payload: unknown) => {
  const requestId = readStringField(payload, "requestId");
  const token = readStringField(payload, "token");
  if (requestId) {
    canceledPixelCaptureRequestIds.add(requestId);
  }
  if (!requestId && !token) {
    return;
  }
  try {
    await cancelPixelCaptureHandler?.({
      ...(requestId ? { requestId } : {}),
      ...(token ? { token } : {}),
    });
  } catch {
    // The original prepare/restore request owns the user-visible error.
  }
});

ipcRenderer.on("paseo:browser:capture-restore", async (_event, payload: unknown) => {
  const requestId = readStringField(payload, "requestId");
  const token = readStringField(payload, "token");
  if (!requestId || !token || !restorePixelCaptureHandler) {
    ipcRenderer.send("paseo:browser:capture-restored", {
      requestId: requestId ?? "unknown",
      ok: false,
      message: "Browser pixel capture restore is unavailable.",
    });
    return;
  }

  try {
    await restorePixelCaptureHandler({ token });
    ipcRenderer.send("paseo:browser:capture-restored", { requestId, ok: true });
  } catch (error) {
    ipcRenderer.send("paseo:browser:capture-restored", {
      requestId,
      ok: false,
      message: errorMessage(error),
    });
  }
});

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
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("paseo:window:openNew", options),
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
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:askWithCheckbox", message, options),
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
  editor: {
    listTargets: () => ipcRenderer.invoke("paseo:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      path: string;
      cwd?: string;
      mode?: "open" | "reveal";
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
  },
  browser: {
    registerWorkspaceBrowser: (input: { browserId: string; workspaceId: string }) =>
      ipcRenderer.invoke("paseo:browser:register-workspace-browser", input),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("paseo:browser:set-workspace-active-browser", input),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:open-devtools", browserId),
    clearPartition: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:clear-partition", browserId),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
    onPrepareForPixelCapture: (handler: BrowserPixelCapturePrepareHandler): (() => void) => {
      prepareForPixelCaptureHandler = handler;
      return () => {
        if (prepareForPixelCaptureHandler === handler) {
          prepareForPixelCaptureHandler = null;
        }
      };
    },
    onRestorePixelCapture: (handler: BrowserPixelCaptureRestoreHandler): (() => void) => {
      restorePixelCaptureHandler = handler;
      return () => {
        if (restorePixelCaptureHandler === handler) {
          restorePixelCaptureHandler = null;
        }
      };
    },
    onCancelPixelCapture: (handler: BrowserPixelCaptureCancelHandler): (() => void) => {
      cancelPixelCaptureHandler = handler;
      return () => {
        if (cancelPixelCaptureHandler === handler) {
          cancelPixelCaptureHandler = null;
        }
      };
    },
  },
});
