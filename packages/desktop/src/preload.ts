import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";
import type { BrowserTunnelEvent } from "./features/browser-tunnel.js";

const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--paseo-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
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
      minimize: () => ipcRenderer.invoke("paseo:window:minimize"),
      close: () => ipcRenderer.invoke("paseo:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("paseo:window:updateChrome", update),
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
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("paseo:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    tunnel: {
      start: (id: string) => ipcRenderer.invoke("paseo:browser:tunnel:start", id),
      stop: (id: string) => ipcRenderer.invoke("paseo:browser:tunnel:stop", id),
      write: (id: string, data: string) =>
        ipcRenderer.invoke("paseo:browser:tunnel:write", id, data),
      close: (id: string) => ipcRenderer.invoke("paseo:browser:tunnel:close", id),
      resume: (id: string) => ipcRenderer.invoke("paseo:browser:tunnel:resume", id),
      onSocket: (handler: (event: BrowserTunnelEvent) => void): Promise<() => void> => {
        const listener = (_event: Electron.IpcRendererEvent, payload: BrowserTunnelEvent) =>
          handler(payload);
        ipcRenderer.on("paseo:browser:tunnel:socket", listener);
        return Promise.resolve(() =>
          ipcRenderer.removeListener("paseo:browser:tunnel:socket", listener),
        );
      },
    },
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("paseo:browser:set-shortcut-policy", input),
    profilePartition: PASEO_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("paseo:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("paseo:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("paseo:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("paseo:browser:clear-profile", legacyBrowserIds),
    listImportSources: () => ipcRenderer.invoke("paseo:browser:list-import-sources"),
    readImportCookies: (sourceId: string) =>
      ipcRenderer.invoke("paseo:browser:read-import-cookies", sourceId),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
    respondToPasswordSave: (input: { requestId: string; action: "save" | "never" | "dismiss" }) =>
      ipcRenderer.invoke("paseo:browser:passwords:respond", input),
    listSavedPasswords: () => ipcRenderer.invoke("paseo:browser:passwords:list"),
    removeSavedPassword: (input: { origin: string; username: string }) =>
      ipcRenderer.invoke("paseo:browser:passwords:remove", input),
  },
});
