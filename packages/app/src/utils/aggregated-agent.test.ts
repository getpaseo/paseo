import { describe, expect, it } from "vitest";
import { toAggregatedAgent } from "./aggregated-agent";
import { describeExternalSessionRecovery } from "./external-session";
import type { Agent } from "@/stores/session-store";

function makeAgent(input?: Partial<Agent>): Agent {
  const timestamp = new Date("2026-04-12T10:00:00.000Z");
  return {
    serverId: "server-1",
    id: input?.id ?? "agent-1",
    provider: input?.provider ?? "codex",
    status: input?.status ?? "closed",
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
    persistence: input?.persistence ?? {
      provider: "codex",
      sessionId: "tmux:codex-main",
      metadata: {
        externalSessionSource: "tmux_codex",
        sessionId: "codex-main",
      },
    },
    runtimeInfo: input?.runtimeInfo,
    lastUsage: input?.lastUsage,
    lastError: input?.lastError ?? null,
    title: input?.title ?? "Agent",
    cwd: input?.cwd ?? "/workspace/project",
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

describe("toAggregatedAgent", () => {
  it("preserves external session metadata for recovery-aware lists", () => {
    const aggregated = toAggregatedAgent({
      source: makeAgent(),
      serverId: "server-1",
      serverLabel: "Local",
    });

    const descriptor = describeExternalSessionRecovery(aggregated);
    expect(descriptor.canRecoverWhenClosed).toBe(true);
    expect(descriptor.restartLabel).toBe("Reopen tmux session");
  });
});
