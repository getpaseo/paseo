import {
  NativeBrowserFrameRequestSchema,
  NativeBrowserCommandRequestSchema,
  NativeBrowserEventsRequestSchema,
} from "@getpaseo/protocol/browser-native";
import { ipcMain, nativeImage, type WebContents } from "electron";
import type { NativeBrowserEvent, NativeBrowserFrame } from "@getpaseo/protocol/browser-native";
import {
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWorkspaceId,
} from "../browser-webviews/index.js";

interface Capture {
  tail: Promise<unknown>;
  events: NativeBrowserEvent[];
  bytes: number;
  dropped: number;
  rawFrame: { data: string; sessionId: number; metadata: { timestamp?: number } } | null;
  acknowledgements: Set<number>;
  frame: NativeBrowserFrame | null;
  streaming: boolean;
  demandedAt: number;
  notBefore: number;
  previousThrottling: boolean | null;
  host: WebContents | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}
const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const captures = new WeakMap<WebContents, Capture>();
const hostDemand = new WeakMap<WebContents, { guests: Set<WebContents>; previous: boolean }>();
function keepHostActive(host: WebContents, guest: WebContents) {
  let demand = hostDemand.get(host);
  if (!demand) {
    demand = { guests: new Set(), previous: host.getBackgroundThrottling() };
    hostDemand.set(host, demand);
    host.setBackgroundThrottling(false);
  }
  demand.guests.add(guest);
}
function releaseHost(capture: Capture, guest: WebContents) {
  const host = capture.host;
  if (!host) return;
  capture.host = null;
  const demand = hostDemand.get(host);
  if (!demand) return;
  demand.guests.delete(guest);
  if (!demand.guests.size) {
    if (!host.isDestroyed()) host.setBackgroundThrottling(demand.previous);
    hostDemand.delete(host);
  }
}

function observe(contents: WebContents): Capture {
  const existing = captures.get(contents);
  if (existing) return existing;
  const capture: Capture = {
    tail: Promise.resolve(),
    events: [],
    bytes: 0,
    dropped: 0,
    frame: null,
    rawFrame: null,
    acknowledgements: new Set(),
    streaming: false,
    demandedAt: 0,
    notBefore: 0,
    previousThrottling: null,
    host: null,
    stopTimer: null,
  };
  captures.set(contents, capture);
  contents.debugger.on("message", (_event, method, params, sessionId) => {
    if (method === "Page.screencastFrame") {
      const packet = params as {
        data: string;
        sessionId: number;
        metadata: { timestamp?: number };
      };
      if (!capture.streaming || packet.data.length > 8_000_000) {
        void contents.debugger
          .sendCommand("Page.screencastFrameAck", { sessionId: packet.sessionId })
          .catch(() => {});
        return;
      }
      capture.acknowledgements.add(packet.sessionId);
      capture.rawFrame = packet;
      return;
    }
    // Discovery can mention the app itself; native bridge consumers own only this guest.
    if (method.startsWith("Target.target")) return;
    const event = {
      method,
      params: params as Record<string, unknown>,
      ...(sessionId ? { sessionId } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > MAX_EVENT_BYTES) {
      capture.dropped++;
      return;
    }
    while (capture.events.length >= MAX_EVENTS || capture.bytes + size > MAX_EVENT_BYTES) {
      capture.bytes -= Buffer.byteLength(JSON.stringify(capture.events.shift()!));
      capture.dropped++;
    }
    capture.events.push(event);
    capture.bytes += size;
  });
  contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      capture.frame = null;
      capture.notBefore = Date.now() + 50;
    }
  });
  contents.on("did-navigate", () => {
    capture.frame = null;
    capture.notBefore = Date.now() + 50;
  });
  contents.debugger.on("detach", () => {
    if (capture.stopTimer) clearTimeout(capture.stopTimer);
    capture.stopTimer = null;
    capture.streaming = false;
    capture.frame = null;
    if (capture.previousThrottling !== null && !contents.isDestroyed())
      contents.setBackgroundThrottling(capture.previousThrottling);
    capture.previousThrottling = null;
    releaseHost(capture, contents);
  });
  contents.once("destroyed", () => {
    if (capture.stopTimer) clearTimeout(capture.stopTimer);
    releaseHost(capture, contents);
    capture.events = [];
    capture.bytes = 0;
  });
  return capture;
}

function resolveGuest(sender: WebContents, input: Record<string, unknown>): WebContents {
  if (typeof input.browserId !== "string" || typeof input.workspaceId !== "string") {
    throw new Error("Native browser and workspace IDs are required");
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(input.browserId, sender.id);
  if (!contents || getPaseoBrowserWorkspaceId(input.browserId) !== input.workspaceId) {
    throw new Error("Native browser does not belong to this host window and workspace");
  }
  return contents;
}

interface NativeIpcRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}
function hostSender(event: unknown): WebContents {
  const contents = (event as { sender?: WebContents })?.sender;
  if (!contents || typeof contents.id !== "number")
    throw new Error("Native CDP requires a host window");
  return contents;
}
function consumeNativeFrame(contents: WebContents, capture: Capture): void {
  const rawFrame = capture.rawFrame;
  capture.rawFrame = null;
  for (const sessionId of capture.acknowledgements)
    void contents.debugger.sendCommand("Page.screencastFrameAck", { sessionId }).catch(() => {});
  capture.acknowledgements.clear();
  if (
    rawFrame &&
    typeof rawFrame.metadata.timestamp === "number" &&
    rawFrame.metadata.timestamp * 1000 > capture.notBefore
  ) {
    const image = nativeImage.createFromBuffer(Buffer.from(rawFrame.data, "base64"));
    const dimensions = image.getSize();
    if (
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= 1280 &&
      dimensions.height <= 960
    ) {
      // Electron guest canvases may be transparent. JPEG needs an explicit
      // browser-white canvas; dropping alpha directly makes text disappear.
      const pixels = image.toBitmap();
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3]!;
        if (alpha === 255) continue;
        const white = 255 - alpha;
        pixels[index] = Math.min(255, pixels[index]! + white);
        pixels[index + 1] = Math.min(255, pixels[index + 1]! + white);
        pixels[index + 2] = Math.min(255, pixels[index + 2]! + white);
        pixels[index + 3] = 255;
      }
      const data = nativeImage.createFromBitmap(pixels, dimensions).toJPEG(65).toString("base64");
      if (data.length <= 1_099_900)
        capture.frame = {
          data: "data:image/jpeg;base64," + data,
          ...dimensions,
          capturedAt: rawFrame.metadata.timestamp * 1000,
        };
    }
  }
}

export function registerNativeBrowserBridgeIpc(ipc: NativeIpcRegistry = ipcMain): void {
  ipc.handle("paseo:browser:native-frame", async (event, raw: unknown) => {
    const input = NativeBrowserFrameRequestSchema.parse(raw);
    const contents = resolveGuest(hostSender(event), input);
    const capture = observe(contents);
    capture.demandedAt = Date.now();
    if (!capture.streaming) {
      capture.streaming = true;
      capture.host = hostSender(event);
      keepHostActive(capture.host, contents);
      capture.previousThrottling = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        await contents.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", {
          color: { r: 255, g: 255, b: 255, a: 1 },
        });
        await contents.debugger.sendCommand("Page.startScreencast", {
          format: "png",
          quality: 65,
          maxWidth: 1280,
          maxHeight: 960,
          everyNthFrame: 1,
        });
      } catch (error) {
        capture.streaming = false;
        if (capture.previousThrottling !== null && !contents.isDestroyed())
          contents.setBackgroundThrottling(capture.previousThrottling);
        capture.previousThrottling = null;
        releaseHost(capture, contents);
        throw error;
      }
    }
    consumeNativeFrame(contents, capture);
    if (capture.stopTimer) clearTimeout(capture.stopTimer);
    capture.stopTimer = setTimeout(() => {
      if (!contents.isDestroyed())
        void contents.debugger.sendCommand("Page.stopScreencast").catch(() => {});
      capture.streaming = false;
      if (capture.previousThrottling !== null && !contents.isDestroyed())
        contents.setBackgroundThrottling(capture.previousThrottling);
      capture.previousThrottling = null;
      releaseHost(capture, contents);
      capture.frame = null;
      capture.rawFrame = null;
      capture.acknowledgements.clear();
      capture.stopTimer = null;
    }, 2500);
    return capture.frame &&
      capture.frame.capturedAt + 1500 > Date.now() &&
      capture.frame.capturedAt > (input.notBefore ?? 0)
      ? capture.frame
      : null;
  });
  ipc.handle("paseo:browser:native-command", async (event, raw: unknown) => {
    const input = NativeBrowserCommandRequestSchema.parse(raw);
    const contents = resolveGuest(hostSender(event), input);
    const method = input.method;
    const contextMethods = new Set([
      "Browser.grantPermissions",
      "Browser.resetPermissions",
      "Browser.setPermission",
      "Browser.setDownloadBehavior",
    ]);
    if (
      method.startsWith("Browser.") &&
      method !== "Browser.getVersion" &&
      !contextMethods.has(method)
    )
      throw new Error("This browser-level command is outside the native guest");

    if (
      method.startsWith("Target.") &&
      !["Target.getTargets", "Target.getTargetInfo"].includes(method)
    ) {
      throw new Error("Use native browser tab tools for target lifecycle operations");
    }
    const params = input.params ?? {};
    if (params.browserContextId !== undefined)
      throw new Error("Explicit browser contexts are outside the native guest");
    if (Buffer.byteLength(JSON.stringify(params)) > MAX_EVENT_BYTES)
      throw new Error("CDP parameters exceed the size limit");
    const capture = observe(contents);
    const execute = async () => {
      if (contents.isDestroyed()) throw new Error("Native browser was closed");
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      if (method === "Target.getTargets" || method === "Target.getTargetInfo") {
        const own = await contents.debugger.sendCommand("Target.getTargetInfo");
        if (params.targetId && params.targetId !== own.targetInfo.targetId)
          throw new Error("Target is outside this native browser");
        return method === "Target.getTargets" ? { targetInfos: [own.targetInfo] } : own;
      }

      const cookies: Record<string, string> = {
        "Storage.getCookies": "Network.getAllCookies",
        "Storage.setCookies": "Network.setCookies",
        "Storage.clearCookies": "Network.clearBrowserCookies",
      };
      if (cookies[method]) return contents.debugger.sendCommand(cookies[method], params);
      if (contextMethods.has(method)) {
        const own = await contents.debugger.sendCommand("Target.getTargetInfo");
        if (!own.targetInfo.browserContextId)
          throw new Error("Native guest browser context is unavailable");
        return contents.debugger.sendCommand(method, {
          ...params,
          browserContextId: own.targetInfo.browserContextId,
        });
      }
      return contents.debugger.sendCommand(method, params);
    };
    // A pending Runtime command can wait for a dialog reply or debugger resume.
    // Queueing its unblocker behind it would leave the guest permanently paused.
    const unblockers = new Set([
      "Page.handleJavaScriptDialog",
      "Debugger.resume",
      "Debugger.stepInto",
      "Debugger.stepOut",
      "Debugger.stepOver",
      "Debugger.disable",
      "Runtime.terminateExecution",
      "Runtime.runIfWaitingForDebugger",
      "Fetch.continueRequest",
      "Fetch.continueResponse",
      "Fetch.fulfillRequest",
      "Fetch.failRequest",
      "Fetch.continueWithAuth",
      "Fetch.disable",
    ]);
    if (unblockers.has(method)) return execute();
    const pending = capture.tail.then(execute);
    capture.tail = pending.catch(() => undefined);
    return pending;
  });
  ipc.handle("paseo:browser:native-events", (event, raw: unknown) => {
    const input = NativeBrowserEventsRequestSchema.parse(raw);
    const capture = observe(resolveGuest(hostSender(event), input));
    const matches = (item: NativeBrowserEvent) =>
      typeof input.method !== "string" || item.method === input.method;
    const events = capture.events.filter(matches);
    if (input.clear !== false) capture.events = capture.events.filter((item) => !matches(item));
    capture.bytes = capture.events.reduce(
      (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
      0,
    );
    const dropped = capture.dropped;
    if (input.clear !== false) capture.dropped = 0;
    return { events, dropped };
  });
}
