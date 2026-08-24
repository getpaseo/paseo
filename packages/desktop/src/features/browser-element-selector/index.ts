import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { runSerializedPixelCapture } from "../browser-automation/service.js";
import {
  BROWSER_ELEMENT_BEGIN_CHANNEL,
  BROWSER_ELEMENT_CANCEL_CHANNEL,
  BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL,
  BROWSER_ELEMENT_GUEST_CANCEL_CHANNEL,
  BROWSER_ELEMENT_GUEST_READY_CHANNEL,
  BROWSER_ELEMENT_GUEST_RESULT_CHANNEL,
  type BrowserElementBeginInput,
  type BrowserElementSelectorResponse,
} from "./channels.js";

interface ActiveSelectorSession {
  browserId: string;
  guest: WebContents;
  hostWebContentsId: number;
  input: BrowserElementBeginInput;
  resolve(response: BrowserElementSelectorResponse): void;
  timeout: ReturnType<typeof setTimeout>;
  disposeNavigation: () => void;
}

const SELECTOR_TIMEOUT_MS = 30_000;

function validBeginInput(value: unknown): value is BrowserElementBeginInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.browserId === "string" &&
    input.browserId.trim().length > 0 &&
    typeof input.token === "string" &&
    input.token.length >= 8 &&
    (input.mode === "annotate" || input.mode === "screenshot")
  );
}

function normalizeRect(value: unknown): Electron.Rectangle | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const [x, y, width, height] = values as number[];
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sendToFrames(guest: WebContents, channel: string, ...args: unknown[]): void {
  if (guest.isDestroyed()) return;
  for (const frame of guest.mainFrame.framesInSubtree) {
    try {
      frame.send(channel, ...args);
    } catch {
      // A frame may disappear during navigation. Remaining frames still receive the message.
    }
  }
}

function sendToFrame(frame: WebFrameMain | null, channel: string, ...args: unknown[]): void {
  try {
    frame?.send(channel, ...args);
  } catch {
    // The requesting frame navigated before the reply.
  }
}

export function registerBrowserElementSelectorIpc(options: {
  ipcMain: IpcMain;
  getGuest(browserId: string, hostWebContentsId: number): WebContents | null;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}): () => void {
  const sessions = new Map<string, ActiveSelectorSession>();
  const sessionKey = (hostWebContentsId: number, browserId: string) =>
    `${hostWebContentsId}:${browserId}`;

  const finish = (session: ActiveSelectorSession, response: BrowserElementSelectorResponse) => {
    const key = sessionKey(session.hostWebContentsId, session.browserId);
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    clearTimeout(session.timeout);
    session.disposeNavigation();
    sendToFrames(session.guest, BROWSER_ELEMENT_GUEST_CANCEL_CHANNEL, session.input.token);
    session.resolve(response);
  };

  const begin = (
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<BrowserElementSelectorResponse> | BrowserElementSelectorResponse => {
    if (!validBeginInput(value)) return { status: "failed", reason: "unavailable" };
    const input = value;
    const guest = options.getGuest(input.browserId, event.sender.id);
    if (!guest || guest.isDestroyed()) return { status: "failed", reason: "unavailable" };
    if (guest.isLoading()) return { status: "failed", reason: "loading" };

    const key = sessionKey(event.sender.id, input.browserId);
    const previous = sessions.get(key);
    if (previous) finish(previous, { status: "cancelled" });

    return new Promise<BrowserElementSelectorResponse>((resolve) => {
      const handleNavigation = (
        _navigationEvent: Electron.Event,
        _url: string,
        isSameDocument: boolean,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame && !isSameDocument) finish(session, { status: "cancelled" });
      };
      const handleDestroyed = () => finish(session, { status: "cancelled" });
      const disposeNavigation = () => {
        guest.removeListener("did-start-navigation", handleNavigation);
        guest.removeListener("destroyed", handleDestroyed);
      };
      const session: ActiveSelectorSession = {
        browserId: input.browserId,
        guest,
        hostWebContentsId: event.sender.id,
        input,
        resolve,
        timeout: setTimeout(
          () => finish(session, { status: "failed", reason: "timeout" }),
          SELECTOR_TIMEOUT_MS,
        ),
        disposeNavigation,
      };
      sessions.set(key, session);
      guest.on("did-start-navigation", handleNavigation);
      guest.once("destroyed", handleDestroyed);
      sendToFrames(guest, BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL, input);
    });
  };

  const cancel = (event: IpcMainInvokeEvent, value: unknown): boolean => {
    if (!validBeginInput(value)) return false;
    const session = sessions.get(sessionKey(event.sender.id, value.browserId));
    if (!session || session.input.token !== value.token) return false;
    finish(session, { status: "cancelled" });
    return true;
  };

  const guestReady = (event: IpcMainEvent) => {
    for (const session of sessions.values()) {
      if (session.guest.id === event.sender.id) {
        sendToFrame(event.senderFrame, BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL, session.input);
      }
    }
  };

  const guestResult = (event: IpcMainEvent, value: unknown) => {
    if (!value || typeof value !== "object") return;
    const result = value as Record<string, unknown>;
    if (typeof result.token !== "string" || typeof result.status !== "string") return;
    const session = Array.from(sessions.values()).find(
      (candidate) =>
        candidate.guest.id === event.sender.id && candidate.input.token === result.token,
    );
    if (!session) return;
    if (result.status === "cancelled") {
      finish(session, { status: "cancelled" });
      return;
    }
    if (result.status === "failed") {
      const reason = result.reason === "loading" ? "loading" : "unavailable";
      finish(session, { status: "failed", reason });
      return;
    }
    if (result.status !== "selected" || !result.selection || typeof result.selection !== "object")
      return;
    const rect = normalizeRect((result.selection as Record<string, unknown>).boundingRect);
    if (!rect) {
      finish(session, { status: "failed", reason: "unavailable" });
      return;
    }
    void runSerializedPixelCapture(() => session.guest.capturePage(rect))
      .then((image) => {
        finish(session, {
          status: "selected",
          mode: session.input.mode,
          selection: result.selection as Record<string, unknown>,
          screenshotDataUrl: image.isEmpty() ? null : image.toDataURL(),
        });
        return undefined;
      })
      .catch((error) => {
        options.warn?.("browser element capture failed", {
          browserId: session.browserId,
          error: error instanceof Error ? error.message : String(error),
        });
        finish(session, {
          status: "selected",
          mode: session.input.mode,
          selection: result.selection as Record<string, unknown>,
          screenshotDataUrl: null,
        });
        return undefined;
      });
  };

  options.ipcMain.handle(BROWSER_ELEMENT_BEGIN_CHANNEL, begin);
  options.ipcMain.handle(BROWSER_ELEMENT_CANCEL_CHANNEL, cancel);
  options.ipcMain.on(BROWSER_ELEMENT_GUEST_READY_CHANNEL, guestReady);
  options.ipcMain.on(BROWSER_ELEMENT_GUEST_RESULT_CHANNEL, guestResult);
  return () => {
    options.ipcMain.removeHandler(BROWSER_ELEMENT_BEGIN_CHANNEL);
    options.ipcMain.removeHandler(BROWSER_ELEMENT_CANCEL_CHANNEL);
    options.ipcMain.removeListener(BROWSER_ELEMENT_GUEST_READY_CHANNEL, guestReady);
    options.ipcMain.removeListener(BROWSER_ELEMENT_GUEST_RESULT_CHANNEL, guestResult);
    for (const session of sessions.values()) finish(session, { status: "cancelled" });
  };
}
