import { describe, expect, it } from "vitest";
import { createHoverSafeZoneTracker, type RectLike } from "@/hooks/hover-safe-zone-tracker";

const TRIGGER: RectLike = { left: 0, right: 100, top: 20, bottom: 60 };
const CONTENT: RectLike = { left: 120, right: 240, top: 20, bottom: 120 };

interface TrackerHandle {
  pointerMoved(x: number, y: number): void;
  pointerLeftWindow(): void;
  windowBlurred(): void;
  readonly enters: number;
  readonly leaves: number;
}

function createHandle(
  rects: { trigger: RectLike | null; content: RectLike | null } = {
    trigger: TRIGGER,
    content: CONTENT,
  },
): TrackerHandle {
  let enters = 0;
  let leaves = 0;
  const tracker = createHoverSafeZoneTracker({
    getTriggerRect: () => rects.trigger,
    getContentRect: () => rects.content,
    onEnterSafeZone: () => {
      enters += 1;
    },
    onLeaveSafeZone: () => {
      leaves += 1;
    },
  });
  return {
    pointerMoved: tracker.pointerMoved,
    pointerLeftWindow: tracker.pointerLeftWindow,
    windowBlurred: tracker.windowBlurred,
    get enters() {
      return enters;
    },
    get leaves() {
      return leaves;
    },
  };
}

describe("hover safe-zone tracker", () => {
  it("tracks transitions across trigger, bridge, content, and outside space", () => {
    const handle = createHandle();

    // Bridge between trigger and content.
    handle.pointerMoved(110, 40);
    expect(handle.enters).toBe(1);
    expect(handle.leaves).toBe(0);

    // Outside everything — fires leave once.
    handle.pointerMoved(300, 40);
    expect(handle.leaves).toBe(1);

    // Back into the bridge — fires enter again.
    handle.pointerMoved(130, 40);
    expect(handle.enters).toBe(2);
  });

  it("refreshes the safe-zone enter callback while moving inside", () => {
    const handle = createHandle();

    handle.pointerMoved(110, 40);
    handle.pointerMoved(130, 40);

    expect(handle.enters).toBe(2);
    expect(handle.leaves).toBe(0);
  });

  it("treats leaving the browser window as leaving the safe zone", () => {
    const handle = createHandle();

    handle.pointerLeftWindow();
    expect(handle.leaves).toBe(1);

    // Already outside — blur does not fire a second leave.
    handle.windowBlurred();
    expect(handle.leaves).toBe(1);
  });

  it("falls back to trigger-or-content membership when a rect is missing", () => {
    const handle = createHandle({ trigger: TRIGGER, content: null });

    // Inside the trigger.
    handle.pointerMoved(50, 40);
    expect(handle.enters).toBe(1);

    // Inside the (now-missing) bridge — counts as outside.
    handle.pointerMoved(110, 40);
    expect(handle.leaves).toBe(1);
  });

  it("treats overlapping trigger and content as having no bridge", () => {
    const handle = createHandle({
      trigger: { left: 0, right: 200, top: 0, bottom: 50 },
      content: { left: 100, right: 300, top: 60, bottom: 100 },
    });

    // Outside both rects, in what would be a bridge — should be outside.
    handle.pointerMoved(150, 55);
    expect(handle.enters).toBe(0);
    expect(handle.leaves).toBe(1);
  });
});
