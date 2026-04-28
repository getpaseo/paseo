import { describe, expect, it } from "vitest";
import { __private__ } from "./use-all-agents-list";
import type { Agent } from "@/stores/session-store";

function makeAgent(input?: Partial<Agent>): Agent {
  const timestamp = new Date("2026-03-08T10:00:00.000Z");
  return {
    serverId: "server-1",
    id: input?.id ?? "agent-1",
    provider: input?.provider ?? "codex",
    status: input?.status ?? "idle",
    createdAt: input?.createdAt ?? timestamp,
    updatedAt: input?.updatedAt ?? timestamp,
    lastUserMessageAt: input?.lastUserMessageAt ?? null,
    lastActivityAt: input?.lastActivityAt ?? timestamp,
    capabilities: input?.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input?.currentModeId ?? null,
    availableModes: input?.availableModes ?? [],
    pendingPermissions: input?.pendingPermissions ?? [],
    persistence: input?.persistence ?? null,
    runtimeInfo: input?.runtimeInfo,
    lastUsage: input?.lastUsage,
    lastError: input?.lastError ?? null,
    title: input?.title ?? "Agent",
    cwd: input?.cwd ?? "/tmp/project",
    model: input?.model ?? null,
    thinkingOptionId: input?.thinkingOptionId,
    requiresAttention: input?.requiresAttention ?? false,
    attentionReason: input?.attentionReason ?? null,
    attentionTimestamp: input?.attentionTimestamp ?? null,
    archivedAt: input?.archivedAt ?? null,
    labels: input?.labels ?? {},
    projectPlacement: input?.projectPlacement ?? null,
  };
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
