import { describe, expect, it } from "vitest";
import { __private__ } from "./use-all-agents-list";
import type { Agent } from "@/stores/session-store";

const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: "server-1",
  id: "agent-1",
  provider: "codex",
  status: "idle",
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
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
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input?: Partial<Agent>): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

describe("useAllAgentsList", () => {
  it("excludes archived agents by default", () => {
    const visibleAgent = makeAgent({ id: "visible" });
    const archivedAgent = makeAgent({
      id: "archived",
      archivedAt: new Date("2026-03-08T11:00:00.000Z"),
    });

    const result = __private__.buildAllAgentsList({
      agents: [visibleAgent, archivedAgent],
      serverId: "server-1",
      serverLabel: "Local",
      includeArchived: false,
    });

    expect(result.map((agent) => agent.id)).toEqual(["visible"]);
  });

  it("includes archived agents when requested", () => {
    const visibleAgent = makeAgent({ id: "visible" });
    const archivedAgent = makeAgent({
      id: "archived",
      archivedAt: new Date("2026-03-08T11:00:00.000Z"),
    });

    const result = __private__.buildAllAgentsList({
      agents: [visibleAgent, archivedAgent],
      serverId: "server-1",
      serverLabel: "Local",
      includeArchived: true,
    });

    expect(result.map((agent) => agent.id)).toEqual(["visible", "archived"]);
    expect(result[1]?.archivedAt).toEqual(archivedAgent.archivedAt);
  });
});
