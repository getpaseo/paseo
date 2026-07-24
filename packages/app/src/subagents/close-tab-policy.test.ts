import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import {
  resolveAgentForCloseTabPolicy,
  resolveCloseAgentTabPolicy,
  shouldArchiveAgentOnTabClose,
} from "./close-tab-policy";

function makeAgent(input: {
  id: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
}): Agent {
  const createdAt = new Date("2026-03-04T00:00:00.000Z");
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: "/repo",
    workspaceId: "ws-1",
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("falls back to layout-only when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "layout-only" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "layout-only" });
  });
});

describe("resolveAgentForCloseTabPolicy", () => {
  it("prefers the live agents map over agentDetails", () => {
    const live = makeAgent({ id: "agent-1", parentAgentId: null });
    const detail = makeAgent({ id: "agent-1", parentAgentId: "parent-agent" });

    expect(
      resolveAgentForCloseTabPolicy({
        agentId: "agent-1",
        agents: new Map([["agent-1", live]]),
        agentDetails: new Map([["agent-1", detail]]),
      }),
    ).toBe(live);
  });

  it("resolves from agentDetails when the agent is absent from agents", () => {
    const detail = makeAgent({ id: "child-agent", parentAgentId: "parent-agent" });
    const resolved = resolveAgentForCloseTabPolicy({
      agentId: "child-agent",
      agents: new Map(),
      agentDetails: new Map([["child-agent", detail]]),
    });

    expect(resolved).toBe(detail);
    expect(resolveCloseAgentTabPolicy(resolved)).toEqual({ kind: "layout-only" });
    expect(shouldArchiveAgentOnTabClose(resolveCloseAgentTabPolicy(resolved))).toBe(false);
  });

  it("returns null when the agent is missing from both maps", () => {
    expect(
      resolveAgentForCloseTabPolicy({
        agentId: "missing",
        agents: new Map(),
        agentDetails: new Map(),
      }),
    ).toBeNull();
  });
});

describe("shouldArchiveAgentOnTabClose", () => {
  it("archives only for archive-on-close; layout-only does not set archivedAt", () => {
    expect(shouldArchiveAgentOnTabClose({ kind: "archive-on-close" })).toBe(true);
    expect(shouldArchiveAgentOnTabClose({ kind: "layout-only" })).toBe(false);
  });
});
