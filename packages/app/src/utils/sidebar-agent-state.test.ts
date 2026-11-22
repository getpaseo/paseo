import { getWorkspaceDisplayStatus } from "@getpaseo/protocol/agent-state-bucket";
import { describe, expect, it } from "vitest";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarStateBucket,
  type SidebarStateBucket,
} from "./sidebar-agent-state";

describe("deriveSidebarStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("needs_input");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("attention");
  });

  it("does not count initializing agents as running", () => {
    expect(
      deriveSidebarStateBucket({
        status: "initializing",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("done");
  });
});

describe("aggregateSidebarStateBuckets", () => {
  it("keeps a reminder below every active status and above Done", () => {
    const result = { followUpAt: "2026-11-22T12:00:00Z" };
    for (const status of ["needs_input", "failed", "running", "attention"] as const) {
      expect(getWorkspaceDisplayStatus({ status, reviewResults: [result] })).toBe(status);
      expect(aggregateSidebarStateBuckets(["needs_follow_up", status])).toBe(status);
    }
    expect(getWorkspaceDisplayStatus({ status: "done", reviewResults: [result] })).toBe(
      "needs_follow_up",
    );
    expect(
      getWorkspaceDisplayStatus({ status: "done", reviewResults: [{ ...result, nested: true }] }),
    ).toBe("done");
    expect(aggregateSidebarStateBuckets(["needs_follow_up", "done"])).toBe("needs_follow_up");
  });

  it("returns done for a project with no workspaces", () => {
    expect(aggregateSidebarStateBuckets([])).toBe("done");
  });

  it("returns done when every workspace is done", () => {
    expect(aggregateSidebarStateBuckets(["done", "done", "done"])).toBe("done");
  });

  it("surfaces a single running workspace among finished ones", () => {
    expect(aggregateSidebarStateBuckets(["done", "running", "done"])).toBe("running");
  });

  it("prefers needs_input over every other bucket", () => {
    expect(aggregateSidebarStateBuckets(["running", "attention", "failed", "needs_input"])).toBe(
      "needs_input",
    );
  });

  it("prefers failed over attention and running", () => {
    expect(aggregateSidebarStateBuckets(["running", "attention", "failed"])).toBe("failed");
  });

  it("prefers running over ready-to-review so a working project keeps its loader", () => {
    expect(aggregateSidebarStateBuckets(["attention", "running"])).toBe("running");
  });

  it("prefers ready-to-review over done", () => {
    expect(aggregateSidebarStateBuckets(["done", "attention", "done"])).toBe("attention");
  });

  it("follows the full needs_input > failed > running > attention > done ordering", () => {
    // Each pair of adjacent buckets: the more urgent one wins when both are present.
    expect(aggregateSidebarStateBuckets(["failed", "needs_input"])).toBe("needs_input");
    expect(aggregateSidebarStateBuckets(["running", "failed"])).toBe("failed");
    expect(aggregateSidebarStateBuckets(["attention", "running"])).toBe("running");
    expect(aggregateSidebarStateBuckets(["done", "attention"])).toBe("attention");
  });

  it("is order-independent", () => {
    const buckets: SidebarStateBucket[] = ["attention", "running", "failed"];
    expect(aggregateSidebarStateBuckets(buckets)).toBe(
      aggregateSidebarStateBuckets(buckets.toReversed()),
    );
  });
});
