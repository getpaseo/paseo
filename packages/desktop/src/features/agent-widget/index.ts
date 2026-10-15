import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import {
  WidgetActionSchema,
  WidgetActionResultSchema,
  WidgetActionProgressSchema,
  WidgetSnapshotSchema,
  type WidgetActionResult,
  type WidgetDisplay,
  type WidgetSnapshot,
  type WidgetRequest,
} from "@getpaseo/protocol/desktop-agent-widget";
import { widgetDocument } from "./document.js";

interface Publisher {
  contents: WebContents;
  hosts: Map<string, WidgetSnapshot>;
}
interface PendingAction {
  owner: number;
  resolve(result: WidgetActionResult): void;
  timer: ReturnType<typeof setTimeout>;
}
interface OwnedRequest {
  owner: Publisher;
  request: WidgetRequest;
  online: boolean;
}

export function widgetBounds(area: Electron.Rectangle, reduced: boolean): Electron.Rectangle {
  const width = Math.min(reduced ? 260 : 512, area.width);
  const height = reduced ? Math.min(80, area.height) : Math.max(1, area.height - 32);
  return {
    x: area.x + Math.max(0, area.width - width - 16),
    y: area.y + Math.max(0, area.height - height - 16),
    width,
    height,
  };
}

export function registerAgentWidget(
  localUpdate?: { active: string; attach(window: BrowserWindow, popup: boolean): void } | null,
) {
  const publishers = new Map<number, Publisher>();
  const pending = new Map<string, PendingAction>();
  const runningKeys = new Set<string>();
  const completed = new Set<string>();
  let requestKeys = new Set<string>();
  let requestGeneration = 0;
  let window: BrowserWindow | null = null;
  let reduced = false;
  let hidden = false;
  let quitting = false;

  function hosts() {
    const selected = new Map<string, { owner: Publisher; snapshot: WidgetSnapshot }>();
    for (const owner of publishers.values()) {
      for (const [id, snapshot] of owner.hosts) {
        const previous = selected.get(id);
        if (!previous || (!previous.snapshot.online && snapshot.online))
          selected.set(id, { owner, snapshot });
      }
    }
    return selected;
  }
  function requests(): OwnedRequest[] {
    const result: OwnedRequest[] = [];
    for (const { owner, snapshot } of hosts().values()) {
      for (const request of snapshot.requests) {
        if (!completed.has(request.key)) result.push({ owner, request, online: snapshot.online });
      }
    }
    return result;
  }
  function display(): WidgetDisplay | null {
    const first = hosts().values().next().value;
    if (!first) return null;
    return {
      labels: first.snapshot.labels,
      requests: requests().map((entry) =>
        Object.assign({}, entry.request, { online: entry.online }),
      ),
    };
  }
  function position() {
    if (!window || window.isDestroyed()) return;
    const current = window.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const bounds = widgetBounds(area, reduced);
    window.setBounds({
      ...bounds,
      x: Math.max(area.x, Math.min(current.x, area.x + area.width - bounds.width)),
      y: Math.max(area.y, Math.min(current.y, area.y + area.height - bounds.height)),
    });
  }
  function setReduced(value: boolean) {
    reduced = value || !requests().length;
    position();
    if (window && !window.isDestroyed())
      window.webContents.send("paseo:agent-widget:reduced", reduced);
  }
  function hide() {
    hidden = true;
    window?.hide();
  }
  function update() {
    const value = display();
    const nextKeys = new Set(value?.requests.map((request) => request.key) ?? []);
    const arrived = [...nextKeys].some((key) => !requestKeys.has(key));
    requestKeys = nextKeys;
    if (arrived) {
      requestGeneration++;
      hidden = false;
      setReduced(false);
    }
    if (!value || !value.requests.length) {
      if (value) window?.webContents.send("paseo:agent-widget:update", value);
      window?.hide();
      return;
    }
    if (!window) {
      window = new BrowserWindow({
        ...widgetBounds(screen.getPrimaryDisplay().workArea, reduced),
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        title: "Paseo",
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        minimizable: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          additionalArguments: [`--paseo-build-id=${localUpdate?.active ?? ""}`],
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      localUpdate?.attach(window, true);
      window.setAlwaysOnTop(true, "floating");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("close", (event) => {
        if (quitting) return;
        event.preventDefault();
        hide();
      });
      window.on("closed", () => {
        window = null;
      });
      const created = window;
      void created
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(widgetDocument)}`)
        .then(() => {
          if (!created.isDestroyed() && requests().length && !hidden) created.showInactive();
          return;
        })
        .catch((error) => console.error("[agent-widget] Failed to load window", error));
    }
    window.webContents.send("paseo:agent-widget:update", value);
    if (!hidden && !window.isVisible() && !window.webContents.isLoading()) window.showInactive();
  }
  function settle(operationId: string, error: string | null) {
    const operation = pending.get(operationId);
    if (!operation) return;
    clearTimeout(operation.timer);
    pending.delete(operationId);
    operation.resolve({ operationId, error });
  }
  function renew(operationId: string, owner: number) {
    const operation = pending.get(operationId);
    if (!operation || operation.owner !== owner) return;
    clearTimeout(operation.timer);
    operation.timer = setTimeout(
      () => settle(operationId, "No confirmation received. Check the agent before retrying."),
      30000,
    );
  }
  function assertWidget(sender: WebContents) {
    if (sender !== window?.webContents) throw new Error("Unknown widget window.");
  }
  ipcMain.handle("paseo:agent-widget:publish", (event, raw: unknown) => {
    const owner = publishers.get(event.sender.id);
    if (!owner) throw new Error("Unknown application window.");
    const snapshot = WidgetSnapshotSchema.parse(raw);
    if (snapshot.requests.some((request) => request.serverId !== snapshot.serverId))
      throw new Error("Invalid host request.");
    owner.hosts.set(snapshot.serverId, snapshot);
    update();
  });
  ipcMain.handle("paseo:agent-widget:ready", (event) => {
    assertWidget(event.sender);
    window?.webContents.send("paseo:agent-widget:reduced", reduced);
    return display();
  });
  ipcMain.handle("paseo:agent-widget:reduce", (event, value: unknown) => {
    assertWidget(event.sender);
    if (typeof value !== "boolean") throw new Error("Invalid widget size.");
    setReduced(value);
  });
  ipcMain.handle("paseo:agent-widget:hide", (event) => {
    assertWidget(event.sender);
    hide();
  });
  ipcMain.handle("paseo:agent-widget:act", async (event, raw: unknown) => {
    assertWidget(event.sender);
    const action = WidgetActionSchema.parse(raw);
    const entry = requests().find((item) => item.request.key === action.key);
    if (!entry?.online || entry.owner.contents.isDestroyed())
      throw new Error("This request is unavailable. Reconnect or open the agent.");
    if (
      action.type === "handoff" &&
      (entry.request.handoffDisabledReason ||
        entry.request.planCallId !== action.planCallId ||
        entry.request.planText !== action.planText)
    )
      throw new Error(entry.request.handoffDisabledReason ?? "This plan has been replaced.");
    if (
      action.type === "handoff" &&
      (!action.profileId ||
        !entry.request.handoffProfiles?.some((profile) => profile.id === action.profileId))
    )
      throw new Error("Choose an available agent profile to hand off this plan.");
    if (runningKeys.has(action.key)) throw new Error("A response is already being sent.");
    runningKeys.add(action.key);
    const generation = requestGeneration;
    const operationId = randomUUID();
    try {
      const result = await new Promise<WidgetActionResult>((resolve) => {
        const timer = setTimeout(
          () => settle(operationId, "No confirmation received. Check the agent before retrying."),
          30000,
        );
        pending.set(operationId, { owner: entry.owner.contents.id, resolve, timer });
        entry.owner.contents.send("paseo:agent-widget:action", {
          operationId,
          serverId: entry.request.serverId,
          action,
        });
      });
      if (!result.error) {
        completed.add(action.key);
        if (requestGeneration === generation) setReduced(true);
      }
      return result;
    } finally {
      runningKeys.delete(action.key);
      update();
    }
  });
  ipcMain.handle("paseo:agent-widget:result", (event, raw: unknown) => {
    const result = WidgetActionResultSchema.parse(raw);
    if (pending.get(result.operationId)?.owner !== event.sender.id) return;
    settle(result.operationId, result.error);
  });
  ipcMain.handle("paseo:agent-widget:progress", (event, raw: unknown) => {
    const { operationId } = WidgetActionProgressSchema.parse(raw);
    renew(operationId, event.sender.id);
  });
  screen.on("display-metrics-changed", position);
  screen.on("display-added", position);
  screen.on("display-removed", position);
  app.on("before-quit", () => {
    quitting = true;
    window?.destroy();
  });

  return {
    isWindow: (candidate: BrowserWindow) => candidate === window,
    attach(ownerWindow: BrowserWindow) {
      const contents = ownerWindow.webContents;
      publishers.set(contents.id, { contents, hosts: new Map() });
      const clear = () => {
        publishers.get(contents.id)?.hosts.clear();
        for (const [id, action] of pending)
          if (action.owner === contents.id) settle(id, "The application window disconnected.");
        update();
      };
      contents.on("did-start-navigation", (_event, _url, sameDocument, mainFrame) => {
        if (mainFrame && !sameDocument) clear();
      });
      contents.on("render-process-gone", clear);
      ownerWindow.on("closed", () => {
        clear();
        publishers.delete(contents.id);
        if (!publishers.size) {
          window?.destroy();
          window = null;
        }
      });
    },
  };
}
