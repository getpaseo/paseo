import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  registerNativeBrowserBridgeIpc,
  type NativeBrowserContents,
  type NativeBrowserImage,
} from "./native-bridge.js";

class Image implements NativeBrowserImage {
  constructor(private dimensions: { width: number; height: number }) {}
  getSize() {
    return this.dimensions;
  }
  toBitmap() {
    return Buffer.alloc(this.dimensions.width * this.dimensions.height * 4);
  }
  toJPEG() {
    return Buffer.from(JSON.stringify(this.dimensions));
  }
  resize(dimensions: { width: number; height: number }) {
    return new Image(dimensions);
  }
}

class GuestDebugger extends EventEmitter {
  private attached = false;
  public attach() {
    this.attached = true;
  }
  public isAttached() {
    return this.attached;
  }
  public sendCommand = vi.fn(
    async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      if (method === "Page.getLayoutMetrics")
        return {
          cssVisualViewport: { pageX: 320, pageY: 1800, clientWidth: 1600, clientHeight: 1200 },
        };
      if (method === "Page.captureScreenshot")
        return { data: Buffer.from("fresh jpeg").toString("base64") };
      if (method === "Target.getTargetInfo")
        return { targetInfo: { targetId: "own-target", browserContextId: "own-context" } };
      return {};
    },
  );
}
class Guest extends EventEmitter implements NativeBrowserContents {
  public readonly debugger = new GuestDebugger();
  public destroyed = false;
  public throttled = true;
  public constructor(public readonly id: number) {
    super();
  }
  public isDestroyed() {
    return this.destroyed;
  }
  public getBackgroundThrottling() {
    return this.throttled;
  }
  public setBackgroundThrottling(value: boolean) {
    this.throttled = value;
  }
}
const identity = { browserId: "browser", workspaceId: "workspace" };
function fixture(imageSize = { width: 1280, height: 960 }) {
  const host = new Guest(1);
  const guest = new Guest(2);
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerNativeBrowserBridgeIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      getGuest: (browserId, hostId) =>
        browserId === identity.browserId && hostId === host.id ? guest : null,
      getWorkspaceId: (browserId) =>
        browserId === identity.browserId ? identity.workspaceId : null,
      images: {
        createFromBuffer() {
          return new Image(imageSize);
        },
        createFromBitmap(_buffer, dimensions) {
          return new Image(dimensions);
        },
      },
    },
  );
  const call = async (channel: string, input: Record<string, unknown> = {}, sender = host) => {
    const handler = handlers.get(`paseo:browser:native-${channel}`);
    if (!handler) throw Error("Missing native IPC handler");
    return handler({ sender }, { ...identity, ...input });
  };
  return { host, guest, call };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("native browser IPC", () => {
  test("inspects paused call frames before resuming the original Runtime command", async () => {
    const { guest, call } = fixture();
    const running = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    guest.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === "Runtime.evaluate") {
        started.resolve();
        return running.promise;
      }
      if (method === "Debugger.evaluateOnCallFrame") return { result: { value: 42 } };
      if (method === "Runtime.getProperties")
        return { result: [{ name: "local", value: { value: 42 } }] };
      if (method === "Debugger.resume") running.resolve({ result: { value: "done" } });
      return {};
    });
    const evaluating = call("command", { method: "Runtime.evaluate" });
    await started.promise;
    await expect(
      call("command", {
        method: "Debugger.evaluateOnCallFrame",
        params: { callFrameId: "frame", expression: "local" },
      }),
    ).resolves.toEqual({ result: { value: 42 } });
    await expect(
      call("command", { method: "Runtime.getProperties", params: { objectId: "scope" } }),
    ).resolves.toEqual({ result: [{ name: "local", value: { value: 42 } }] });
    await call("command", { method: "Debugger.resume" });
    await expect(evaluating).resolves.toEqual({ result: { value: "done" } });
  });

  test("captures a fresh bounded image when a quiet page has no new screencast paints", async () => {
    const { guest, call } = fixture();
    const first = await call("frame");
    expect(first).toEqual({
      data: `data:image/jpeg;base64,${Buffer.from("fresh jpeg").toString("base64")}`,
      width: 1280,
      height: 960,
      capturedAt: 10000,
    });
    expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "jpeg",
      quality: 65,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 320, y: 1800, width: 1600, height: 1200, scale: 0.8 },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const next = await call("frame", { notBefore: 11000 });
    expect(next).toEqual({
      data: `data:image/jpeg;base64,${Buffer.from("fresh jpeg").toString("base64")}`,
      width: 1280,
      height: 960,
      capturedAt: 11600,
    });
    expect(
      guest.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(2);
  });
  test("refuses requests from another host or workspace before reaching the debugger", async () => {
    const { guest, call } = fixture();
    await expect(call("command", { method: "DOM.getDocument" }, new Guest(9))).rejects.toThrow(
      /host window and workspace/,
    );
    await expect(call("events", { workspaceId: "elsewhere" })).rejects.toThrow(
      /host window and workspace/,
    );
    await expect(call("frame", { browserId: "missing" })).rejects.toThrow(
      /host window and workspace/,
    );
    await expect(call("command", { method: "invalid" })).rejects.toThrow();
    expect(guest.debugger.sendCommand).not.toHaveBeenCalled();
  });

  test("bounds high-DPI screenshots and reports the final encoded pixel dimensions", async () => {
    const { guest, call } = fixture({ width: 3200, height: 2400 });
    const send = guest.debugger.sendCommand.getMockImplementation()!;
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === "Page.captureScreenshot")
        return { data: Buffer.alloc(900_000, 1).toString("base64") };
      return send(method, params);
    });
    const dimensions = { width: 1280, height: 960 };
    await expect(call("frame")).resolves.toEqual({
      ...dimensions,
      data: `data:image/jpeg;base64,${Buffer.from(JSON.stringify(dimensions)).toString("base64")}`,
      capturedAt: 10000,
    });
  });

  test("finishes a still capture before changing viewport while allowing unblockers through", async () => {
    const { guest, call } = fixture();
    const screenshot = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const send = guest.debugger.sendCommand.getMockImplementation()!;
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Page.captureScreenshot") {
        started.resolve();
        return screenshot.promise;
      }
      return send(method, params);
    });
    const capturing = call("frame");
    await started.promise;
    const params = { width: 800, height: 600, deviceScaleFactor: 2, mobile: true };
    const emulating = call("command", { method: "Emulation.setDeviceMetricsOverride", params });
    await call("command", { method: "Page.handleJavaScriptDialog", params: { accept: false } });
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setDeviceMetricsOverride",
      params,
    );
    screenshot.resolve({ data: Buffer.from("fresh jpeg").toString("base64") });
    await capturing;
    await emulating;
    expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setDeviceMetricsOverride",
      params,
    );
  });

  test("captures while JavaScript waits even when a viewport command is queued behind it", async () => {
    const { guest, call } = fixture();
    const running = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const send = guest.debugger.sendCommand.getMockImplementation()!;
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate") {
        started.resolve();
        return running.promise;
      }
      return send(method, params);
    });
    const evaluating = call("command", { method: "Runtime.evaluate" });
    await started.promise;
    const params = { width: 800, height: 600, deviceScaleFactor: 1, mobile: false };
    const emulating = call("command", { method: "Emulation.setDeviceMetricsOverride", params });
    let frame: unknown = null;
    const capturing = call("frame").then((result) => {
      frame = result;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(frame).toMatchObject({ width: 1280, height: 960, capturedAt: 10000 });
      expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setDeviceMetricsOverride",
        params,
      );
    } finally {
      running.resolve({ result: { value: "done" } });
      await Promise.all([evaluating, emulating, capturing]);
    }
  });

  test("waits for an active viewport change before reading screenshot metrics", async () => {
    const { guest, call } = fixture();
    const changing = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const send = guest.debugger.sendCommand.getMockImplementation()!;
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") {
        started.resolve();
        return changing.promise;
      }
      return send(method, params);
    });
    const emulating = call("command", {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      },
    });
    await started.promise;
    const capturing = call("frame");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith("Page.getLayoutMetrics");
    } finally {
      changing.resolve({});
      await emulating;
      await expect(capturing).resolves.toMatchObject({ width: 1280, height: 960 });
    }
  });

  test("restricts browser-wide commands and maps cookies and permissions to the registered guest", async () => {
    const { guest, call } = fixture();
    await expect(call("command", { method: "Browser.close" })).rejects.toThrow(
      /outside the native guest/,
    );
    await expect(call("command", { method: "Target.attachToTarget" })).rejects.toThrow(/tab tools/);
    await expect(
      call("command", { method: "Storage.getCookies", params: { browserContextId: "foreign" } }),
    ).rejects.toThrow(/outside the native guest/);
    await expect(
      call("command", {
        method: "Runtime.evaluate",
        params: { expression: "x".repeat(2 * 1024 * 1024) },
      }),
    ).rejects.toThrow(/size limit/);
    expect(guest.debugger.sendCommand).not.toHaveBeenCalled();
    await expect(call("command", { method: "Target.getTargets" })).resolves.toEqual({
      targetInfos: [{ targetId: "own-target", browserContextId: "own-context" }],
    });
    await expect(
      call("command", { method: "Target.getTargetInfo", params: { targetId: "foreign" } }),
    ).rejects.toThrow(/outside this native browser/);
    await call("command", { method: "Storage.getCookies" });
    expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith("Network.getAllCookies", {});
    await call("command", {
      method: "Browser.grantPermissions",
      params: { permissions: ["geolocation"] },
    });
    expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith("Browser.grantPermissions", {
      permissions: ["geolocation"],
      browserContextId: "own-context",
    });
  });

  test("bounds buffered events and drains only matching events", async () => {
    const { guest, call } = fixture();
    await call("command", { method: "Network.enable" });
    for (let index = 0; index < 260; index++)
      guest.debugger.emit("message", {}, "Network.requestWillBeSent", { index });
    guest.debugger.emit("message", {}, "Debugger.paused", { reason: "other" });
    await expect(call("events", { method: "Debugger.paused", clear: false })).resolves.toEqual({
      events: [{ method: "Debugger.paused", params: { reason: "other" } }],
      dropped: 5,
    });
    await expect(call("events", { method: "Network.requestWillBeSent" })).resolves.toEqual({
      events: Array.from({ length: 255 }, (_, index) => ({
        method: "Network.requestWillBeSent",
        params: { index: index + 5 },
      })),
      dropped: 5,
    });
    await expect(call("events")).resolves.toEqual({
      events: [{ method: "Debugger.paused", params: { reason: "other" } }],
      dropped: 0,
    });
    await expect(call("events")).resolves.toEqual({ events: [], dropped: 0 });
  });

  test("renews capture demand and restores guest and host throttling after the final viewer stops", async () => {
    const { host, guest, call } = fixture();
    await call("frame");
    expect(host.throttled).toBe(false);
    expect(guest.throttled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await call("frame");
    await vi.advanceTimersByTimeAsync(2499);
    expect(host.throttled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.throttled).toBe(true);
    expect(guest.throttled).toBe(true);
    expect(guest.debugger.sendCommand).toHaveBeenLastCalledWith("Page.stopScreencast");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cleans up capture on detach and guest destruction", async () => {
    const { host, guest, call } = fixture();
    await call("frame");
    guest.debugger.emit("detach");
    expect(host.throttled).toBe(true);
    expect(guest.throttled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await call("frame");
    guest.destroyed = true;
    guest.emit("destroyed");
    expect(host.throttled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(call("command", { method: "DOM.getDocument" })).rejects.toThrow(/closed/);
  });

  test("restores throttling if capture setup fails and permits a subsequent attempt", async () => {
    const { host, guest, call } = fixture();
    guest.debugger.sendCommand.mockRejectedValueOnce(new Error("capture unavailable"));
    await expect(call("frame")).rejects.toThrow("capture unavailable");
    expect(host.throttled).toBe(true);
    expect(guest.throttled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(call("frame")).resolves.toMatchObject({ capturedAt: 10000 });
  });
  test("discards a pending still screenshot if the guest navigates before it completes", async () => {
    const { guest, call } = fixture();
    const screenshot = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    guest.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === "Page.captureScreenshot") {
        started.resolve();
        return screenshot.promise;
      }
      return {};
    });
    const capturing = call("frame");
    await started.promise;
    guest.emit("did-start-navigation", {}, "https://next.test", false, true);
    screenshot.resolve({ data: Buffer.from("old page").toString("base64") });
    await expect(capturing).resolves.toBeNull();
  });
});
