import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, dialog, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import {
  DesktopExecuteRequestSchema,
  type DesktopExecuteResponse,
  type DesktopCommand,
  DesktopCaptureTargetSchema,
  type DesktopCaptureDraft,
  type DesktopCaptureTarget,
} from "@getpaseo/protocol/desktop-capture";
import { resolveDesktopDaemonStatus } from "../../daemon/daemon-manager.js";
import { startCaptureHelper, type CaptureHelperEvent } from "./helper.js";

export function registerDesktopCapture(input: {
  url: string;
  preload: string;
  openAgent(target: DesktopCaptureTarget): Promise<void>;
}) {
  if (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 23) return null;
  const deviceId = randomUUID();
  const helperExecutable = app.isPackaged
    ? path.join(process.resourcesPath, "desktop-capture/paseo-desktop-capture")
    : path.join(__dirname, "../../native/paseo-desktop-capture");
  const toolRequests = new Map<
    string,
    {
      sessionId: string;
      command: DesktopCommand;
      resolve(value: DesktopExecuteResponse): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const earlyOcr = new Map<string, string>();
  let localServerId: string | null = null;
  void resolveDesktopDaemonStatus()
    .then((status) => {
      if (status.status === "running") localServerId = status.serverId;
      return;
    })
    .catch(() => {});
  const toolIds = new Set<string>();
  let window: BrowserWindow | null = null;
  let draft: DesktopCaptureDraft | null = null;
  let target: DesktopCaptureTarget | null = null;
  let quitting = false;
  let pendingCapture = false;
  let helper: ReturnType<typeof startCaptureHelper> | null = null;
  function publish() {
    window?.webContents.send("paseo:desktop-capture:update", draft);
  }
  function createWindow() {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(720, area.width);
    const height = Math.min(620, area.height);
    const created = new BrowserWindow({
      title: "Paseo",
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      show: false,
      type: "panel",
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: input.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window = created;
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      created.hide();
    });
    created.on("closed", () => {
      window = null;
    });
    void created
      .loadURL(input.url)
      .catch((error: unknown) => console.error("[desktop-capture] Window failed", error));
  }
  function show() {
    if (!window) createWindow();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    window!.setPosition(
      Math.round(area.x + (area.width - window!.getBounds().width) / 2),
      Math.round(area.y + (area.height - window!.getBounds().height) / 2),
    );
    window!.show();
    publish();
  }
  function recoverInput() {
    for (const pending of toolRequests.values()) {
      const command = pending.command;
      let args: string[];
      if (command.command === "click") args = ["--release-button", command.button];
      else if (command.command === "shortcut") args = ["--release-key", String(command.keyCode)];
      else if (command.command === "type_text") args = ["--release-key", "0"];
      else continue;
      try {
        execFileSync(helperExecutable, args, { timeout: 1000, stdio: "ignore" });
      } catch (error) {
        console.error("[desktop-capture] Failed to release interrupted input", error);
      }
    }
  }
  function stopTools(sessionId?: string, notify = true) {
    for (const [id, pending] of toolRequests) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      toolRequests.delete(id);
      pending.resolve({
        type: "desktop.control.execute.response",
        payload: {
          requestId: id,
          sessionId: pending.sessionId,
          ok: false,
          error: "Desktop control revoked. Outcome unknown; do not replay.",
        },
      });
    }
    if (notify) window?.webContents.send("paseo:desktop-capture:stopped");
  }
  function receiveTool(event: CaptureHelperEvent): boolean {
    if (!("id" in event) || !toolIds.has(event.id)) return false;
    if (!toolRequests.has(event.id)) return true;
    const pending = toolRequests.get(event.id)!;
    clearTimeout(pending.timer);
    toolRequests.delete(event.id);
    let result: Record<string, unknown> = {};
    if (event.event === "capture")
      result = {
        png: event.png,
        width: event.width,
        height: event.height,
        display: event.display,
      };
    if (event.event === "result") result = event.result;
    pending.resolve({
      type: "desktop.control.execute.response",
      payload: {
        requestId: event.id,
        sessionId: pending.sessionId,
        ok: event.event !== "error",
        result,
        ...(event.event === "error" ? { error: event.error } : {}),
      },
    });
    return true;
  }
  async function receive(event: CaptureHelperEvent) {
    if (event.event === "stopped") {
      stopTools(event.sessionId);
      return;
    }
    if (receiveTool(event)) return;
    if (event.event === "ocr") {
      if (draft?.id === event.id) {
        draft.ocr = event.text;
        publish();
      } else {
        earlyOcr.clear();
        earlyOcr.set(event.id, event.text);
      }
      return;
    }
    if (event.event === "capture") {
      if (draft || pendingCapture) {
        show();
        return;
      }
      pendingCapture = true;
      try {
        if (!localServerId) {
          const status = await resolveDesktopDaemonStatus();
          if (status.status === "running") localServerId = status.serverId;
        }
        if (!localServerId) throw new Error("Ouvrez Paseo et réessayez.");
        draft = {
          id: event.id,
          deviceId,
          serverId: localServerId,
          png: event.png,
          width: event.width,
          height: event.height,
          context: event.context,
          ocr: earlyOcr.get(event.id) ?? "",
          captureMs: event.captureMs,
        };
        target = null;
        show();
      } catch (error) {
        await dialog.showMessageBox({
          message: error instanceof Error ? error.message : "Capture indisponible.",
          type: "error",
        });
      } finally {
        pendingCapture = false;
      }
    }
    if (event.event === "error") {
      await dialog.showMessageBox({
        message: "Autorisez la capture d’écran dans les réglages du Mac, puis réessayez.",
        type: "error",
      });
    }
  }
  helper = startCaptureHelper({
    executable: helperExecutable,
    onEvent(event) {
      void receive(event).catch((error: unknown) =>
        console.error("[desktop-capture] Capture failed", error),
      );
    },
    onDisconnect(error) {
      recoverInput();
      stopTools();
      helper = null;
      console.error("[desktop-capture] Helper stopped", error.message);
    },
  });
  createWindow();
  function requireOwner(event: IpcMainInvokeEvent) {
    if (!window || event.sender.id !== window.webContents.id)
      throw new Error("Not the desktop capture window.");
  }
  ipcMain.handle("paseo:desktop-capture:para", async (event) => {
    requireOwner(event);
    const directory = "/Users/sylvaindivito/Desktop/PARA";
    await mkdir(directory, { recursive: true });
    return directory;
  });
  ipcMain.handle("paseo:desktop-capture:device", (event) => {
    requireOwner(event);
    return deviceId;
  });
  ipcMain.handle("paseo:desktop-capture:execute", (event, raw: unknown) => {
    requireOwner(event);
    const request = DesktopExecuteRequestSchema.parse(raw);
    if (request.deviceId !== deviceId || !helper) throw new Error("Desktop control unavailable.");
    if (toolIds.has(request.requestId)) throw new Error("Duplicate desktop action.");
    return new Promise<DesktopExecuteResponse>((resolve) => {
      const timer = setTimeout(() => {
        helper?.command({ command: "revoke", sessionId: request.sessionId });
        stopTools(request.sessionId);
      }, 14000);
      toolIds.add(request.requestId);
      toolRequests.set(request.requestId, {
        sessionId: request.sessionId,
        command: request.command,
        resolve,
        timer,
      });
      helper!.command({
        command: "control",
        id: request.requestId,
        sessionId: request.sessionId,
        action: request.command,
      });
    });
  });
  ipcMain.handle("paseo:desktop-capture:revoke", (event, sessionId: unknown) => {
    requireOwner(event);
    if (typeof sessionId !== "string") throw new Error("Invalid desktop session");
    helper?.command({ command: "revoke", sessionId });
    stopTools(sessionId, false);
  });
  window!.webContents.on("render-process-gone", () => {
    helper?.stop();
    recoverInput();
    stopTools();
  });
  ipcMain.handle("paseo:desktop-capture:get", (event) => {
    requireOwner(event);
    return draft;
  });
  ipcMain.handle("paseo:desktop-capture:cancel", (event) => {
    requireOwner(event);
    draft = null;
    target = null;
    window?.hide();
    publish();
  });
  ipcMain.handle("paseo:desktop-capture:complete", (event, raw: unknown) => {
    requireOwner(event);
    const parsed = DesktopCaptureTargetSchema.parse(raw);
    if (target && JSON.stringify(target) === JSON.stringify(parsed)) return;
    if (!draft || parsed.serverId !== draft.serverId)
      throw new Error("Invalid capture destination.");
    target = parsed;
    draft = null;
  });
  ipcMain.handle("paseo:desktop-capture:open", async (event) => {
    requireOwner(event);
    if (target) {
      await input.openAgent(target);
      window?.hide();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    helper?.stop();
    recoverInput();
    window?.destroy();
  });
  return {
    isWindow: (candidate: BrowserWindow) => candidate === window,
    permissions: () => helper?.command({ command: "permissions" }),
    setShortcut: (modifiers: number) => helper?.command({ command: "shortcut", modifiers }),
  };
}
