import { describe, expect, it } from "vitest";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceAgentNode } from "./agent-tree";
import {
  buildAgentRowPresentation,
  buildAgentRowTarget,
  buildTerminalRowPresentation,
  buildTerminalRowTarget,
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

describe("row tab targets", () => {
  // A row highlights when its target's tab id matches the focused tab. If the
  // target it navigates to ever diverged from the one it compares against, the
  // row would open one tab and highlight another.
  it("opens and highlights the same tab for a Paseo agent", () => {
    const target = buildAgentRowTarget(agent({ id: "agent-1" }));
    expect(target).toEqual({ kind: "agent", agentId: "agent-1" });
    expect(buildDeterministicWorkspaceTabId(target)).toBe("agent_agent-1");
  });

  it("opens and highlights the same tab for a provider subagent", () => {
    const target = buildAgentRowTarget(
      agent({ id: "sub-1", kind: "provider", parentAgentId: "parent-1" }),
    );
    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-1",
      subagentId: "sub-1",
    });
    // Provider subagent ids are length-prefixed, so two different parent/child
    // splits can never collide into the same tab id.
    expect(buildDeterministicWorkspaceTabId(target)).toBe("provider_subagent_8_parent-1_5_sub-1");
  });

  it("opens and highlights the same tab for a terminal", () => {
    const target = buildTerminalRowTarget("term-1");
    expect(target).toEqual({ kind: "terminal", terminalId: "term-1" });
    expect(buildDeterministicWorkspaceTabId(target)).toBe("terminal_term-1");
  });

  it("keeps agent and terminal tab ids in separate namespaces", () => {
    const sameId = "collide";
    expect(buildDeterministicWorkspaceTabId(buildAgentRowTarget(agent({ id: sameId })))).not.toBe(
      buildDeterministicWorkspaceTabId(buildTerminalRowTarget(sameId)),
    );
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
