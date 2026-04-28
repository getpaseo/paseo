/**
 * Hubcode browser panes backed by Electron `WebContentsView`.
 *
 * We replaced the renderer-side `<webview>` element with this because
 * `<webview>` contents are NOT exposed through `--remote-debugging-port`
 * — Playwright / CDP only sees the top-level BrowserWindow. A
 * `WebContentsView` attached to the main window IS a CDP target, so
 * the daemon's PlaywrightBrowserManager can drive it.
 *
 * Positioning: a `WebContentsView` is an OS-level overlay, not part of
 * the DOM, so the renderer sends rect updates every time the pane
 * resizes. We clip the view to those pixel bounds on the main window.
 */

import { BrowserWindow, WebContentsView, ipcMain, type IpcMainInvokeEvent } from "electron";

interface ManagedView {
  browserId: string;
  view: WebContentsView;
  attachedWindow: BrowserWindow;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

const views = new Map<string, ManagedView>();

function roundRect(r: {
  x: number;
  y: number;
  width: number;
  height: number;
}): ManagedView["bounds"] {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)),
    height: Math.max(0, Math.round(r.height)),
  };
}

/** Hide a view by parking it off-screen; we don't detach from the
 * window because re-attaching has flicker. `setVisible(false)` also
 * works but some Electron versions repaint anyway. */
function hiddenBounds(): ManagedView["bounds"] {
  return { x: -10_000, y: -10_000, width: 0, height: 0 };
}

function applyBounds(managed: ManagedView): void {
  const rect = managed.visible ? managed.bounds : hiddenBounds();
  managed.view.setBounds(rect);
}

function windowForSender(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? null;
}

export function registerBrowserViewIpc(): void {
  ipcMain.handle(
    "hubcode:browser-view:create",
    async (event, payload: { browserId: string; url?: string }) => {
      const browserId = payload?.browserId;
      if (!browserId) throw new Error("browser-view:create requires browserId");
      const win = windowForSender(event);
      if (!win) throw new Error("No window for sender");

      // Reuse if already present (client may re-mount the pane).
      const existing = views.get(browserId);
      if (existing) {
        existing.visible = true;
        applyBounds(existing);
        return { ok: true, reused: true };
      }

      const view = new WebContentsView({
        webPreferences: {
          // Persist session so cookies/storage carry across panes,
          // matching the old `<webview>` partition setup.
          partition: "persist:hubcode-browser",
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      // Without this, the renderer starts with a white flash on
      // `about:blank` and Electron's attached DevTools panel flips
      // to light theme (Chromium picks the theme of the most-recent
      // webContents). Using the app's dark surface tone keeps the
      // DevTools theme steady and avoids the jarring flash while the
      // target page is loading.
      try {
        view.setBackgroundColor("#0e0e0e");
      } catch {
        // older Electron versions may not expose setBackgroundColor
      }
      const managed: ManagedView = {
        browserId,
        view,
        attachedWindow: win,
        bounds: hiddenBounds(),
        visible: false,
      };
      win.contentView.addChildView(view);
      applyBounds(managed);
      views.set(browserId, managed);

      // Forward navigation lifecycle to the renderer so the URL bar
      // and loading spinner can stay in sync without polling.
      const sendUpdate = (extra: Record<string, unknown> = {}) => {
        try {
          win.webContents.send("hubcode:browser-view:state", {
            browserId,
            url: view.webContents.getURL(),
            title: view.webContents.getTitle(),
            isLoading: view.webContents.isLoading(),
            ...extra,
          });
        } catch {}
      };
      view.webContents.on("did-navigate", () => sendUpdate());
      view.webContents.on("did-navigate-in-page", (_e, _u, isMain) => {
        if (isMain) sendUpdate();
      });
      view.webContents.on("did-start-loading", () => sendUpdate());
      view.webContents.on("did-stop-loading", () => sendUpdate());
      view.webContents.on("page-title-updated", () => sendUpdate());

      if (payload.url) {
        // Fire-and-forget; Playwright/tools wait via their own logic.
        void view.webContents.loadURL(payload.url).catch(() => {});
      }
      return { ok: true, reused: false };
    },
  );

  ipcMain.handle(
    "hubcode:browser-view:set-bounds",
    async (
      _event,
      payload: { browserId: string; x: number; y: number; width: number; height: number },
    ) => {
      const managed = views.get(payload.browserId);
      if (!managed) return { ok: false, error: "not found" };
      managed.bounds = roundRect(payload);
      if (managed.visible) applyBounds(managed);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "hubcode:browser-view:set-visible",
    async (_event, payload: { browserId: string; visible: boolean }) => {
      const managed = views.get(payload.browserId);
      if (!managed) return { ok: false };
      managed.visible = !!payload.visible;
      applyBounds(managed);
      return { ok: true };
    },
  );

  ipcMain.handle("hubcode:browser-view:destroy", async (_event, payload: { browserId: string }) => {
    const managed = views.get(payload.browserId);
    if (!managed) return { ok: false };
    try {
      managed.attachedWindow.contentView.removeChildView(managed.view);
    } catch {}
    try {
      (managed.view.webContents as any)?.close?.();
    } catch {}
    views.delete(payload.browserId);
    return { ok: true };
  });

  ipcMain.handle(
    "hubcode:browser-view:load-url",
    async (_event, payload: { browserId: string; url: string }) => {
      const managed = views.get(payload.browserId);
      if (!managed) throw new Error("browser-view not found");
      await managed.view.webContents.loadURL(payload.url).catch(() => {});
      return { ok: true, url: managed.view.webContents.getURL() };
    },
  );

  ipcMain.handle(
    "hubcode:browser-view:nav",
    async (_event, payload: { browserId: string; action: "back" | "forward" | "reload" }) => {
      const managed = views.get(payload.browserId);
      if (!managed) return { ok: false };
      const wc = managed.view.webContents;
      if (payload.action === "back" && wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
      } else if (payload.action === "forward" && wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward();
      } else if (payload.action === "reload") {
        wc.reload();
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    "hubcode:browser-view:get-state",
    async (_event, payload: { browserId: string }) => {
      const managed = views.get(payload.browserId);
      if (!managed) return { ok: false };
      const wc = managed.view.webContents;
      return {
        ok: true,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        isLoading: wc.isLoading(),
      };
    },
  );
}

/** Subscribe a renderer to state changes (did-navigate, title, loading)
 * so the URL bar / spinner can reflect reality without polling. */
export function wireBrowserViewEvents(window: BrowserWindow): void {
  const sendAll = (browserId: string, channel: string, data: any) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, { browserId, ...data });
      }
    }
  };
  // Wire up when a view is created later — but this function can also
  // be called post-hoc. We hook per-view events inside the create
  // handler below.
  void window;
  void sendAll;
}
