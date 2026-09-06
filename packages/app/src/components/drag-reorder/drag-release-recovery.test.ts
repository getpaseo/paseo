import { afterEach, describe, expect, it, vi } from "vitest";
import { createDragReleaseRecovery, DRAG_RELEASE_RECOVERY_DELAY_MS } from "./drag-release-recovery";

afterEach(() => {
  vi.useRealTimers();
});

describe("drag release recovery", () => {
  it("recovers a drag that does not finish after the finger is released", () => {
    vi.useFakeTimers();
    const onRecover = vi.fn();
    const recovery = createDragReleaseRecovery(onRecover);

    recovery.dragBegan();
    recovery.fingerReleased();
    vi.advanceTimersByTime(DRAG_RELEASE_RECOVERY_DELAY_MS - 1);
    expect(onRecover).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onRecover).toHaveBeenCalledOnce();
  });

  it("leaves a normally completed drag alone", () => {
    vi.useFakeTimers();
    const onRecover = vi.fn();
    const recovery = createDragReleaseRecovery(onRecover);

    recovery.dragBegan();
    recovery.fingerReleased();
    recovery.dragFinished();
    vi.advanceTimersByTime(DRAG_RELEASE_RECOVERY_DELAY_MS);

    expect(onRecover).not.toHaveBeenCalled();
  });

  it("does not let an older release cancel a newer drag", () => {
    vi.useFakeTimers();
    const onRecover = vi.fn();
    const recovery = createDragReleaseRecovery(onRecover);

    recovery.dragBegan();
    recovery.fingerReleased();
    recovery.dragBegan();
    vi.advanceTimersByTime(DRAG_RELEASE_RECOVERY_DELAY_MS);
    expect(onRecover).not.toHaveBeenCalled();

    recovery.fingerReleased();
    vi.advanceTimersByTime(DRAG_RELEASE_RECOVERY_DELAY_MS);
    expect(onRecover).toHaveBeenCalledOnce();
  });
});
