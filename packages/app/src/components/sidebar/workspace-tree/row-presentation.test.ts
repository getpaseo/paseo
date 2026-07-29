import { describe, expect, it } from "vitest";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import type { WorkspaceAgentNode } from "./agent-tree";
import {
  buildAgentRowPresentation,
  buildTerminalRowPresentation,
  resolveTreeAgentLabel,
} from "./row-presentation";

function agent(overrides: Partial<WorkspaceAgentNode> = {}): WorkspaceAgentNode {
  return {
    id: "a",
    kind: "paseo",
    parentAgentId: null,
    workspaceId: "ws",
    title: "Agent",
    status: "idle",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    pendingPermissionCount: 0,
    createdAt: 0,
    ...overrides,
  };
}

describe("resolveTreeAgentLabel", () => {
  it("uses a real title", () => {
    expect(resolveTreeAgentLabel("  Fix the parser  ", "Loading…")).toBe("Fix the parser");
  });

  it("falls back to the tab loading label for empty and placeholder titles", () => {
    expect(resolveTreeAgentLabel(null, "Loading…")).toBe("Loading…");
    expect(resolveTreeAgentLabel("   ", "Loading…")).toBe("Loading…");
    expect(resolveTreeAgentLabel("New agent", "Loading…")).toBe("Loading…");
    expect(resolveTreeAgentLabel("new AGENT", "Loading…")).toBe("Loading…");
  });
});

describe("buildAgentRowPresentation", () => {
  it("renders the spinner in place of the icon while running", () => {
    const presentation = buildAgentRowPresentation(agent({ status: "running" }), "Agent");
    expect(presentation.statusBucket).toBe("running");
    expect(shouldRenderSyncedStatusLoader({ bucket: presentation.statusBucket })).toBe(true);
  });

  it("shows the needs-input dot when a permission is pending", () => {
    const presentation = buildAgentRowPresentation(
      agent({ status: "idle", pendingPermissionCount: 1 }),
      "Agent",
    );
    expect(presentation.statusBucket).toBe("needs_input");
    expect(shouldRenderSyncedStatusLoader({ bucket: presentation.statusBucket })).toBe(false);
  });

  it("shows the failed dot for an errored agent", () => {
    expect(buildAgentRowPresentation(agent({ status: "error" }), "Agent").statusBucket).toBe(
      "failed",
    );
  });

  it("shows the attention dot when the agent finished and wants attention", () => {
    expect(
      buildAgentRowPresentation(
        agent({ status: "idle", requiresAttention: true, attentionReason: "finished" }),
        "Agent",
      ).statusBucket,
    ).toBe("attention");
  });

  it("shows no indicator for a settled agent", () => {
    expect(buildAgentRowPresentation(agent({ status: "idle" }), "Agent").statusBucket).toBe("done");
  });

  it("marks provider subagents with the provider_subagent kind", () => {
    expect(buildAgentRowPresentation(agent({ kind: "provider" }), "Sub").kind).toBe(
      "provider_subagent",
    );
    expect(buildAgentRowPresentation(agent({ kind: "paseo" }), "Root").kind).toBe("agent");
  });
});

describe("buildTerminalRowPresentation", () => {
  it("spins while the terminal is working", () => {
    const presentation = buildTerminalRowPresentation({
      terminalId: "t1",
      label: "bash",
      activity: { state: "working", attentionReason: null, changedAt: 0 },
    });
    expect(presentation.statusBucket).toBe("running");
    expect(shouldRenderSyncedStatusLoader({ bucket: presentation.statusBucket })).toBe(true);
  });

  it("shows the needs-input dot when the terminal is waiting on input", () => {
    expect(
      buildTerminalRowPresentation({
        terminalId: "t1",
        label: "bash",
        activity: { state: "working", attentionReason: "needs_input", changedAt: 0 },
      }).statusBucket,
    ).toBe("needs_input");
  });

  it("shows no indicator for an idle terminal", () => {
    expect(
      buildTerminalRowPresentation({ terminalId: "t1", label: "bash", activity: null })
        .statusBucket,
    ).toBeNull();
  });
});
