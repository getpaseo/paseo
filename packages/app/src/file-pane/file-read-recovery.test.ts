import { describe, expect, it } from "vitest";
import { FileReadRecoveryTracker } from "./file-read-recovery";

describe("FileReadRecoveryTracker", () => {
  it("rejects a read started before deletion and accepts one started afterward", () => {
    const tracker = new FileReadRecoveryTracker();
    const staleRead = tracker.startRead();

    tracker.observe("missing");

    expect(tracker.canRecoverFrom(staleRead)).toBe(false);
    expect(tracker.needsRecoveryRead(false)).toBe(true);

    const recoveryRead = tracker.startRead();

    expect(tracker.canRecoverFrom(recoveryRead)).toBe(true);
    expect(tracker.needsRecoveryRead(false)).toBe(false);
  });

  it("does not recover after a ready watcher update supersedes the missing state", () => {
    const tracker = new FileReadRecoveryTracker();
    tracker.observe("missing");
    const recoveryRead = tracker.startRead();

    tracker.observe("ready");

    expect(tracker.canRecoverFrom(recoveryRead)).toBe(false);
  });
});
