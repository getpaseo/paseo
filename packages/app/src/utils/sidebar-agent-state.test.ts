import { describe, expect, it } from "vitest";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarStateBucket,
  getSidebarStateBucketPriority,
  isSidebarActiveAgent,
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

  it("keeps the agent's own running, permission, and error states", () => {
    expect(
      deriveSidebarStateBucket({
        status: "running",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "active",
      }),
    ).toBe("running");
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "active",
      }),
    ).toBe("needs_input");
    expect(
      deriveSidebarStateBucket({
        status: "error",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "active",
      }),
    ).toBe("failed");
  });

  it("waits instead of showing a finished turn while a subagent moves", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
        subagentActivity: "active",
      }),
    ).toBe("waiting_on_subagent");
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "active",
      }),
    ).toBe("waiting_on_subagent");
  });

  it("surfaces a blocked child as needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
        subagentActivity: "blocked",
      }),
    ).toBe("needs_input");
  });
});

describe("isSidebarActiveAgent", () => {
  it("counts waiting as active and done as inactive", () => {
    expect(
      isSidebarActiveAgent({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "active",
      }),
    ).toBe(true);
    expect(
      isSidebarActiveAgent({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
        subagentActivity: "none",
      }),
    ).toBe(false);
  });
});

describe("getSidebarStateBucketPriority", () => {
  it("ranks a blocked state above waiting and waiting above a finished turn", () => {
    expect(getSidebarStateBucketPriority("needs_input")).toBeLessThan(
      getSidebarStateBucketPriority("waiting_on_subagent"),
    );
    expect(getSidebarStateBucketPriority("waiting_on_subagent")).toBeLessThan(
      getSidebarStateBucketPriority("attention"),
    );
    expect(getSidebarStateBucketPriority("running")).toBeLessThan(
      getSidebarStateBucketPriority("waiting_on_subagent"),
    );
  });
});

describe("aggregateSidebarStateBuckets", () => {
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

  it("keeps running ahead of waiting on a collapsed project row", () => {
    expect(aggregateSidebarStateBuckets(["running", "waiting_on_subagent"])).toBe("running");
    expect(aggregateSidebarStateBuckets(["waiting_on_subagent", "done"])).toBe(
      "waiting_on_subagent",
    );
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
