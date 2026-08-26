import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { diffMap, diffReplicaInput, type ReplicaInput } from "./diff";

function input(overrides: Partial<ReplicaInput> = {}): ReplicaInput {
  return {
    agents: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    focusedAgentId: undefined,
    timelineItems: undefined,
    timelineRange: null,
    timelineHasOlder: false,
    ...overrides,
  };
}

describe("diffReplicaInput", () => {
  it("upserts only values whose map identity changed and deletes missing ids", () => {
    const retained = { value: "retained" };
    const previousValue = { value: "previous" };
    const changed = { value: "changed" };
    const removed = { value: "removed" };
    const previous = new Map([
      ["retained", retained],
      ["changed", previousValue],
      ["removed", removed],
    ]);
    const next = new Map([
      ["retained", retained],
      ["changed", changed],
    ]);

    expect(diffMap(previous, next)).toEqual({
      upserts: [changed],
      deletes: ["removed"],
    });
  });

  it("does not rewrite the timeline when its inputs retain identity", () => {
    const timelineItems: StreamItem[] = [];
    const range = { epoch: "epoch", startSeq: 1, endSeq: 1 };
    const previous = input({
      focusedAgentId: "agent",
      timelineItems,
      timelineRange: range,
    });
    const next = input({
      focusedAgentId: "agent",
      timelineItems,
      timelineRange: range,
    });

    expect(diffReplicaInput(previous, next).timelineChanged).toBe(false);
  });

  it("rewrites the timeline when one of its inputs changes identity", () => {
    const previous = input({ focusedAgentId: "agent", timelineItems: [] });
    const next = input({ focusedAgentId: "agent", timelineItems: [] });

    expect(diffReplicaInput(previous, next).timelineChanged).toBe(true);
  });
});
