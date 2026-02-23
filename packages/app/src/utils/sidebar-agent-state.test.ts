import { describe, expect, it } from "vitest";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

describe("deriveSidebarStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      })
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      })
    ).toBe("needs_input");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      })
    ).toBe("attention");
  });
});
