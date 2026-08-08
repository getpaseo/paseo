import { describe, expect, it } from "vitest";
import { AgentDirectorySequenceTracker } from "./agent-directory-sequence.js";

describe("AgentDirectorySequenceTracker", () => {
  it("starts at sequence zero with an empty change log", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    expect(tracker.getCurrentSequence()).toBe(0);
    expect(tracker.getGeneration()).toBe("gen");
    expect(tracker.changesAfter(0)).toEqual({ changes: [], incremental: false });
  });

  it("assigns monotonically increasing sequences to changes", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    tracker.recordChange("a", "upsert");
    tracker.recordChange("b", "delete");
    tracker.recordChange("a", "upsert");
    expect(tracker.getCurrentSequence()).toBe(3);
  });

  it("returns every change after a cursor", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    tracker.recordChange("a", "upsert");
    tracker.recordChange("b", "delete");
    tracker.recordChange("c", "upsert");

    const result = tracker.changesAfter(0);
    expect(result.incremental).toBe(true);
    expect(result.changes).toEqual([
      { seq: 1, type: "upsert", agentId: "a" },
      { seq: 2, type: "delete", agentId: "b" },
      { seq: 3, type: "upsert", agentId: "c" },
    ]);
  });

  it("returns only changes after the cursor", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    tracker.recordChange("a", "upsert");
    tracker.recordChange("b", "upsert");
    tracker.recordChange("c", "upsert");

    const result = tracker.changesAfter(1);
    expect(result.incremental).toBe(true);
    expect(result.changes).toEqual([
      { seq: 2, type: "upsert", agentId: "b" },
      { seq: 3, type: "upsert", agentId: "c" },
    ]);
  });

  it("reports an up-to-date cursor as incremental with no changes", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    tracker.recordChange("a", "upsert");
    expect(tracker.changesAfter(1)).toEqual({ changes: [], incremental: true });
  });

  it("declines a delta when the cursor is older than the retained window", () => {
    const tracker = new AgentDirectorySequenceTracker("gen");
    for (let i = 0; i < 5005; i += 1) {
      tracker.recordChange(`agent-${i}`, "upsert");
    }
    // The first five changes were evicted; seq 1..5 are no longer reconstructible.
    expect(tracker.changesAfter(0)).toEqual({ changes: [], incremental: false });
    expect(tracker.changesAfter(6)).toMatchObject({ incremental: true });
  });

  it("keeps each instance on its own generation", () => {
    expect(new AgentDirectorySequenceTracker().getGeneration()).not.toBe(
      new AgentDirectorySequenceTracker().getGeneration(),
    );
  });
});
