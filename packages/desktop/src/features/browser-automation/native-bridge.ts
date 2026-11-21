import {
  NativeBrowserFrameRequestSchema,
  NativeBrowserCommandRequestSchema,
  NativeBrowserEventsRequestSchema,
} from "@getpaseo/protocol/browser-native";
import type { WebContents, NativeImage } from "electron";
import type { NativeBrowserEvent, NativeBrowserFrame } from "@getpaseo/protocol/browser-native";
import { CdpSessionQueue } from "./cdp-session-queue.js";

export interface NativeBrowserContents extends Pick<
  WebContents,
  "id" | "isDestroyed" | "getBackgroundThrottling" | "setBackgroundThrottling" | "on" | "once"
> {
  debugger: Pick<WebContents["debugger"], "on" | "attach" | "isAttached" | "sendCommand">;
}

export interface NativeBrowserImage extends Pick<NativeImage, "getSize" | "toBitmap" | "toJPEG"> {
  resize(options: { width: number; height: number }): NativeBrowserImage;
}

export interface NativeBrowserBridgeDependencies {
  getGuest(browserId: string, hostId: number): NativeBrowserContents | null;
  getWorkspaceId(browserId: string): string | null;
  images: {
    createFromBuffer(buffer: Buffer): NativeBrowserImage;
    createFromBitmap(buffer: Buffer, size: { width: number; height: number }): NativeBrowserImage;
  };
}

interface Capture {
  commandQueue: CdpSessionQueue;
  viewportQueue: CdpSessionQueue;
  events: NativeBrowserEvent[];
  bytes: number;
  dropped: number;
  rawFrame: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  } | null;
  acknowledgements: Set<number>;
  frame: NativeBrowserFrame | null;
  streaming: boolean;
  generation: number;
  stillTask: Promise<void> | null;
  lastStillAttemptAt: number;
  notBefore: number;
  previousThrottling: boolean | null;
  host: NativeBrowserContents | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}
const MAX_FRAME_WIDTH = 1280;
const MAX_FRAME_HEIGHT = 960;
const MAX_FRAME_DATA_LENGTH = 1_099_900;
const MAX_DECODE_DATA_LENGTH = 8_000_000;
const FRAME_QUALITY = 65;
const FRAME_TTL_MS = 1500;
const CAPTURE_IDLE_MS = 2500;
const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const contextMethods = new Set([
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  "Browser.setDownloadBehavior",
]);
const cookies: Record<string, string> = {
  "Storage.getCookies": "Network.getAllCookies",
  "Storage.setCookies": "Network.setCookies",
  "Storage.clearCookies": "Network.clearBrowserCookies",
};
// Paused JavaScript must not block commands that inspect or resume it.
const unblockers = new Set([
  "Page.handleJavaScriptDialog",
  "Debugger.evaluateOnCallFrame",
  "Debugger.getScriptSource",
  "Runtime.getProperties",
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
const captures = new WeakMap<NativeBrowserContents, Capture>();
const hostDemand = new WeakMap<
  NativeBrowserContents,
  { guests: Set<NativeBrowserContents>; previous: boolean }
>();
function keepHostActive(host: NativeBrowserContents, guest: NativeBrowserContents) {
  let demand = hostDemand.get(host);
  if (!demand) {
    demand = { guests: new Set(), previous: host.getBackgroundThrottling() };
    hostDemand.set(host, demand);
    host.setBackgroundThrottling(false);
  }
  demand.guests.add(guest);
}
function releaseHost(capture: Capture, guest: NativeBrowserContents) {
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

function resetCapture(contents: NativeBrowserContents, capture: Capture): void {
  if (capture.stopTimer) clearTimeout(capture.stopTimer);
  capture.stopTimer = null;
  capture.streaming = false;
  capture.frame = null;
  capture.rawFrame = null;
  capture.acknowledgements.clear();
  if (capture.previousThrottling !== null && !contents.isDestroyed()) {
    contents.setBackgroundThrottling(capture.previousThrottling);
  }
  capture.previousThrottling = null;
  releaseHost(capture, contents);
}

function freshFrame(capture: Capture, notBefore = 0): NativeBrowserFrame | null {
  const frame = capture.frame;
  return frame && frame.capturedAt + FRAME_TTL_MS > Date.now() && frame.capturedAt > notBefore
    ? frame
    : null;
}

function observe(contents: NativeBrowserContents): Capture {
  const existing = captures.get(contents);
  if (existing) return existing;
  const capture: Capture = {
    commandQueue: new CdpSessionQueue(),
    viewportQueue: new CdpSessionQueue(),
    events: [],
    bytes: 0,
    dropped: 0,
    frame: null,
    rawFrame: null,
    acknowledgements: new Set(),
    streaming: false,
    generation: 0,
    stillTask: null,
    lastStillAttemptAt: -Infinity,
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
      if (!capture.streaming || packet.data.length > MAX_DECODE_DATA_LENGTH) {
        void contents.debugger
          .sendCommand("Page.screencastFrameAck", {
            sessionId: packet.sessionId,
          })
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
      capture.generation++;
      capture.frame = null;
      capture.notBefore = Date.now() + 50;
    }
  });
  contents.on("did-navigate", () => {
    capture.generation++;
    capture.frame = null;
    capture.notBefore = Date.now() + 50;
  });
  contents.debugger.on("detach", () => {
    capture.generation++;
    resetCapture(contents, capture);
  });
  contents.once("destroyed", () => {
    capture.generation++;
    resetCapture(contents, capture);
    capture.events = [];
    capture.bytes = 0;
  });
  return capture;
}

interface NativeIpcRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}
function hostSender(event: unknown): NativeBrowserContents {
  const contents = (event as { sender?: NativeBrowserContents })?.sender;
  if (!contents || typeof contents.id !== "number")
    throw new Error("Native CDP requires a host window");
  return contents;
}
function consumeNativeFrame(
  contents: NativeBrowserContents,
  capture: Capture,
  images: NativeBrowserBridgeDependencies["images"],
): void {
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
    const image = images.createFromBuffer(Buffer.from(rawFrame.data, "base64"));
    const dimensions = image.getSize();
    if (
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= MAX_FRAME_WIDTH &&
      dimensions.height <= MAX_FRAME_HEIGHT
    ) {
      // Composite transparent guest pixels onto white before encoding JPEG.
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
      const data = images
        .createFromBitmap(pixels, dimensions)
        .toJPEG(FRAME_QUALITY)
        .toString("base64");
      if (data.length <= MAX_FRAME_DATA_LENGTH)
        capture.frame = {
          data: "data:image/jpeg;base64," + data,
          ...dimensions,
          capturedAt: rawFrame.metadata.timestamp * 1000,
        };
    }
  }
}

async function captureStillFrame(
  contents: NativeBrowserContents,
  capture: Capture,
  captureImages: NativeBrowserBridgeDependencies["images"],
): Promise<void> {
  const generation = capture.generation;
  const capturedAt = Date.now();
  const metrics = await contents.debugger.sendCommand("Page.getLayoutMetrics");
  const {
    pageX: x,
    pageY: y,
    clientWidth: width,
    clientHeight: height,
  } = metrics.cssVisualViewport;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error("Native guest viewport is unavailable");
  const scale = Math.min(1, MAX_FRAME_WIDTH / width, MAX_FRAME_HEIGHT / height);
  const result = await contents.debugger.sendCommand("Page.captureScreenshot", {
    format: "jpeg",
    quality: FRAME_QUALITY,
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale },
  });
  if (contents.isDestroyed() || capture.generation !== generation) return;
  if (
    typeof result.data !== "string" ||
    !/^[A-Za-z0-9+/=]+$/.test(result.data) ||
    result.data.length > MAX_DECODE_DATA_LENGTH
  )
    throw new Error("Native screenshot is invalid or exceeds the decode size limit");
  let image = captureImages.createFromBuffer(Buffer.from(result.data, "base64"));
  const dimensions = image.getSize();
  if (dimensions.width <= 0 || dimensions.height <= 0)
    throw new Error("Native screenshot has no pixels");
  const imageScale = Math.min(
    1,
    MAX_FRAME_WIDTH / dimensions.width,
    MAX_FRAME_HEIGHT / dimensions.height,
  );
  let data = result.data;
  if (imageScale < 1) {
    image = image.resize({
      width: Math.max(1, Math.floor(dimensions.width * imageScale)),
      height: Math.max(1, Math.floor(dimensions.height * imageScale)),
    });
    data = image.toJPEG(FRAME_QUALITY).toString("base64");
  }
  if (data.length > MAX_FRAME_DATA_LENGTH)
    throw new Error("Native screenshot exceeds the image size limit");
  capture.frame = {
    data: `data:image/jpeg;base64,${data}`,
    ...image.getSize(),
    capturedAt,
  };
}

export function registerNativeBrowserBridgeIpc(
  ipc: NativeIpcRegistry,
  dependencies: NativeBrowserBridgeDependencies,
): void {
  function resolveGuest(
    sender: NativeBrowserContents,
    input: { browserId: string; workspaceId: string },
  ): NativeBrowserContents {
    const contents = dependencies.getGuest(input.browserId, sender.id);
    if (!contents || dependencies.getWorkspaceId(input.browserId) !== input.workspaceId) {
      throw new Error("Native browser does not belong to this host window and workspace");
    }
    return contents;
  }

  ipc.handle("paseo:browser:native-frame", async (event, raw: unknown) => {
    const input = NativeBrowserFrameRequestSchema.parse(raw);
    const contents = resolveGuest(hostSender(event), input);
    const capture = observe(contents);
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
          quality: FRAME_QUALITY,
          maxWidth: MAX_FRAME_WIDTH,
          maxHeight: MAX_FRAME_HEIGHT,
          everyNthFrame: 1,
        });
      } catch (error) {
        resetCapture(contents, capture);
        throw error;
      }
    }
    consumeNativeFrame(contents, capture, dependencies.images);
    if (capture.stopTimer) clearTimeout(capture.stopTimer);
    capture.stopTimer = setTimeout(() => {
      if (!contents.isDestroyed())
        void contents.debugger.sendCommand("Page.stopScreencast").catch(() => {});
      resetCapture(contents, capture);
    }, CAPTURE_IDLE_MS);
    if (!freshFrame(capture, input.notBefore) && Date.now() > capture.notBefore) {
      // Quiet pages need a still capture because screencast frames arrive only on paint.
      if (!capture.stillTask && Date.now() - capture.lastStillAttemptAt >= 1000) {
        capture.lastStillAttemptAt = Date.now();
        capture.stillTask = capture.viewportQueue
          .run(() => captureStillFrame(contents, capture, dependencies.images))
          .finally(() => {
            capture.stillTask = null;
          });
      }
      if (capture.stillTask) await capture.stillTask;
    }
    return freshFrame(capture, input.notBefore);
  });
  ipc.handle("paseo:browser:native-command", async (event, raw: unknown) => {
    const input = NativeBrowserCommandRequestSchema.parse(raw);
    const contents = resolveGuest(hostSender(event), input);
    const method = input.method;
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
    if (unblockers.has(method)) return execute();
    return capture.commandQueue.run(() => {
      if (method.startsWith("Emulation.") || method === "Page.captureScreenshot") {
        return capture.viewportQueue.run(execute);
      }
      return execute();
    });
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
