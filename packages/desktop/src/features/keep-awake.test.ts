import { powerSaveBlocker } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeKeepAwakeState, createKeepAwakeCommandHandlers } from "./keep-awake";

vi.mock("electron", () => ({
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));

interface FakeSender {
  id: number;
  isDestroyed: () => boolean;
  once: (event: "destroyed" | "render-process-gone", listener: () => void) => void;
  destroy: () => void;
}

function createFakeSender(id: number): FakeSender {
  let destroyed = false;
  const listeners: Array<() => void> = [];
  return {
    id,
    isDestroyed: () => destroyed,
    once: (_event, listener) => {
      listeners.push(listener);
    },
    destroy: () => {
      destroyed = true;
      for (const listener of listeners.splice(0)) {
        listener();
      }
    },
  };
}

describe("computeKeepAwakeState", () => {
  it("is inactive when not requested", () => {
    expect(computeKeepAwakeState({ enabled: false, batteryLevel: 0.5 })).toEqual({
      active: false,
      suppressedByLowBattery: false,
    });
  });

  it("fails closed when requested but the battery level is unknown", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: null })).toEqual({
      active: false,
      suppressedByLowBattery: true,
    });
  });

  it("is active when requested and battery is above the cutoff", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: 0.1 })).toEqual({
      active: true,
      suppressedByLowBattery: false,
    });
  });

  it("suppresses itself below the 10% battery cutoff even when requested", () => {
    expect(computeKeepAwakeState({ enabled: true, batteryLevel: 0.09 })).toEqual({
      active: false,
      suppressedByLowBattery: true,
    });
  });
});

describe("createKeepAwakeCommandHandlers", () => {
  beforeEach(() => {
    vi.mocked(powerSaveBlocker.start).mockClear();
    vi.mocked(powerSaveBlocker.stop).mockClear();
  });

  it("holds the block while any window reports a running agent", () => {
    const handlers = createKeepAwakeCommandHandlers();
    const windowA = createFakeSender(1);
    const windowB = createFakeSender(2);

    handlers.desktop_set_keep_awake({ enabled: true, batteryLevel: 0.9 }, { sender: windowA });
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    // Window B reports nothing running; window A's request still holds the block.
    handlers.desktop_set_keep_awake({ enabled: false, batteryLevel: 0.9 }, { sender: windowB });
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("releases the block once every window's request is satisfied", () => {
    const handlers = createKeepAwakeCommandHandlers();
    const windowA = createFakeSender(1);

    handlers.desktop_set_keep_awake({ enabled: true, batteryLevel: 0.9 }, { sender: windowA });
    handlers.desktop_set_keep_awake({ enabled: false, batteryLevel: 0.9 }, { sender: windowA });

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it("drops a window's request and releases the block when its WebContents disappears", () => {
    const handlers = createKeepAwakeCommandHandlers();
    const windowA = createFakeSender(1);

    handlers.desktop_set_keep_awake({ enabled: true, batteryLevel: 0.9 }, { sender: windowA });
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    windowA.destroy();

    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it("takes the lowest known battery reading across windows", () => {
    const handlers = createKeepAwakeCommandHandlers();
    const windowA = createFakeSender(1);
    const windowB = createFakeSender(2);

    handlers.desktop_set_keep_awake({ enabled: true, batteryLevel: 0.5 }, { sender: windowA });
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    // Window B reports a low battery; the aggregate must fail closed even
    // though window A's own reading looked safe.
    handlers.desktop_set_keep_awake({ enabled: true, batteryLevel: 0.05 }, { sender: windowB });
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });
});
