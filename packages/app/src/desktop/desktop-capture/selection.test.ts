import { describe, expect, it, vi } from "vitest";
import { captureSelection } from "./selection";
it("normalizes backwards drags and clamps them to the screenshot", () => {
  expect(
    captureSelection({ x: 130, y: 80 }, { x: -20, y: 10 }, { width: 100, height: 100 }),
  ).toEqual({ x: 0, y: 10, width: 100, height: 70 });
});
it("ignores clicks without an area", () => {
  expect(
    captureSelection({ x: 10, y: 10 }, { x: 10, y: 10 }, { width: 100, height: 100 }),
  ).toBeNull();
});

// The release must join both asynchronous results, regardless of arrival order.
import { HoldCapture } from "./hold";
import type { DesktopCaptureDraft } from "@getpaseo/protocol/desktop-capture";
const captured: DesktopCaptureDraft = {
  id: "capture",
  deviceId: "device",
  serverId: "local",
  png: "aGVsbG8=",
  width: 100,
  height: 100,
  context: {},
  ocr: "",
  captureMs: 1,
  gesture: true,
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("hold to capture", () => {
  it("starts while held and sends once after release, capture and transcription", async () => {
    const ready = vi.fn();
    const start = vi.fn(async () => {});
    const finish = vi.fn(async () => "Corrige ceci");
    const hold = new HoldCapture({ start, finish, cancel: vi.fn(async () => {}), ready });
    hold.gesture({ id: "capture", phase: "began" });
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    hold.capture(captured);
    expect(ready).not.toHaveBeenCalled();
    hold.gesture({ id: "capture", phase: "ended" });
    hold.gesture({ id: "capture", phase: "ended" });
    await flush();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledExactlyOnceWith(captured, "Corrige ceci", "");
    hold.capture(captured);
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("waits for a late screenshot and retains speech on failure", async () => {
    const ready = vi.fn();
    const hold = new HoldCapture({
      start: async () => {},
      finish: async () => "Ma demande",
      cancel: async () => {},
      ready,
    });
    hold.gesture({ id: "capture", phase: "began" });
    hold.gesture({ id: "capture", phase: "ended" });
    await flush();
    expect(ready).not.toHaveBeenCalled();
    hold.capture(captured);
    expect(ready).toHaveBeenCalledExactlyOnceWith(captured, "Ma demande", "");
  });
  it("cancels even when microphone startup is still pending; never submits late results", async () => {
    let opened!: () => void;
    const start = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const ready = vi.fn();
    const cancel = vi.fn(async () => {});
    const finish = vi.fn(async () => "wrong");
    const hold = new HoldCapture({ start: () => start, finish, cancel, ready });
    hold.gesture({ id: "capture", phase: "began" });
    await flush();
    hold.gesture({ id: "capture", phase: "ended" });
    hold.gesture({ id: "capture", phase: "cancelled" });
    hold.capture(captured);
    opened();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
  it("surfaces microphone refusal instead of creating an empty agent", async () => {
    const ready = vi.fn();
    const finish = vi.fn(async () => "");
    const hold = new HoldCapture({
      start: async () => {
        throw Error("denied");
      },
      finish,
      cancel: async () => {},
      ready,
    });
    hold.gesture({ id: "capture", phase: "began" });
    hold.gesture({ id: "capture", phase: "ended" });
    hold.capture(captured);
    await flush();
    expect(finish).not.toHaveBeenCalled();
    expect(ready.mock.calls[0][2]).toContain("Micro indisponible");
  });
});
