import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with PASEO_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

type EventHandler = (payload: unknown) => void;

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
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
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      minimize: () => ipcRenderer.invoke("paseo:window:minimize"),
      close: () => ipcRenderer.invoke("paseo:window:close"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
        trafficLightOffsetY?: number;
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
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
  },
});

// Boot window controls.
//
// The app draws its own minimise/maximise/close inside the header row, which means they do
// not exist until the renderer paints and the bundle mounts. Between the window appearing and
// that moment - and for good if the bundle throws or the page fails to load - a frameless
// window would have no way to be closed except Alt+F4 or the taskbar. Ferdium shipped exactly
// that (ferdium/ferdium-app#230, a broken titlebar dependency), and VS Code's pre-workbench
// splash paints the titlebar background with no buttons at all.
//
// So the preload injects a plain-DOM fallback set as soon as the document exists, then removes
// it the moment the app's own controls appear. Exactly one set is ever visible. This lives here
// rather than in index.html because the preload runs ahead of every page script, covers the
// packaged app:// entry and the Metro dev URL alike, and needs no inline-script CSP allowance.
const BOOT_CONTROLS_ID = "paseo-boot-window-controls";
const APP_CONTROL_SELECTOR = '[data-testid="window-control-close"]';

function installBootWindowControls(): void {
  // macOS draws real traffic lights, and a native frame needs nothing from us.
  if (process.platform === "darwin") return;

  const glyph = (paths: string) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const style = document.createElement("style");
  style.textContent = `
#${BOOT_CONTROLS_ID} {
  position: fixed;
  top: 4px;
  right: 12px;
  z-index: 2147483647;
  display: flex;
  gap: 4px;
  -webkit-app-region: no-drag;
}
#${BOOT_CONTROLS_ID} button {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #71717a;
  cursor: default;
}
#${BOOT_CONTROLS_ID} button:hover { background: #f4f4f5; color: #1a1a1e; }
#${BOOT_CONTROLS_ID} button[data-close]:hover { background: #c42b1c; color: #ffffff; }
@media (prefers-color-scheme: dark) {
  #${BOOT_CONTROLS_ID} button { color: #a1a1aa; }
  #${BOOT_CONTROLS_ID} button:hover { background: #27272a; color: #fafafa; }
}`;

  const container = document.createElement("div");
  container.id = BOOT_CONTROLS_ID;

  const buttons: { label: string; channel: string; paths: string; close?: boolean }[] = [
    { label: "Minimize", channel: "paseo:window:minimize", paths: '<path d="M5 12h14"/>' },
    {
      label: "Maximize",
      channel: "paseo:window:toggleMaximize",
      paths: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    },
    {
      label: "Close",
      channel: "paseo:window:close",
      paths: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      close: true,
    },
  ];

  for (const spec of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", spec.label);
    button.setAttribute("data-testid", `boot-window-control-${spec.label.toLowerCase()}`);
    if (spec.close) button.setAttribute("data-close", "true");
    button.innerHTML = glyph(spec.paths);
    button.addEventListener("click", () => {
      void ipcRenderer.invoke(spec.channel);
    });
    container.appendChild(button);
  }

  // Attach to documentElement, not head/body: DOMContentLoaded does not fire until the app
  // bundle has executed, which is the exact window these buttons exist to cover.
  const root = document.documentElement;
  root.appendChild(style);
  root.appendChild(container);

  // Hand over as soon as the app renders its own set, and take back over if they ever go away.
  const sync = () => {
    container.style.display = document.querySelector(APP_CONTROL_SELECTOR) ? "none" : "flex";
  };
  sync();
  new MutationObserver(sync).observe(root, { childList: true, subtree: true });
}

// documentElement exists as soon as parsing starts, well before body or DOMContentLoaded.
if (document.documentElement) {
  installBootWindowControls();
} else {
  const pending = setInterval(() => {
    if (!document.documentElement) return;
    clearInterval(pending);
    installBootWindowControls();
  }, 10);
}
