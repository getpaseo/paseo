import { describe, expect, it } from "vitest";
import { deriveAgentActionSheetState } from "./agent-list-actions";
import type { AggregatedAgent } from "@/types/aggregated-agent";

function makeAggregatedAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  const now = new Date("2026-04-12T10:00:00.000Z");
  return {
    id: overrides.id ?? "agent-1",
    serverId: overrides.serverId ?? "server-1",
    serverLabel: overrides.serverLabel ?? "Local",
    title: overrides.title ?? "Codex session",
    status: overrides.status ?? "closed",
    lastActivityAt: overrides.lastActivityAt ?? now,
    cwd: overrides.cwd ?? "/workspace/project",
    provider: overrides.provider ?? "codex",
    pendingPermissionCount: overrides.pendingPermissionCount ?? 0,
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? now,
    labels: overrides.labels ?? {},
    persistence: overrides.persistence ?? {
      provider: "codex",
      sessionId: "tmux:codex-main",
      metadata: {
        externalSessionSource: "tmux_codex",
        sessionId: "codex-main",
      },
    },
    runtimeInfo: overrides.runtimeInfo,
  };
}

describe("deriveAgentActionSheetState", () => {
  it("offers a recover action for closed external sessions", () => {
    const state = deriveAgentActionSheetState(makeAggregatedAgent(), false);

    expect(state.isRecoverableExternalSession).toBe(true);
    expect(state.title).toBe("Recover this session?");
    expect(state.recoverLabel).toBe("Reopen tmux session");
    expect(state.canRecover).toBe(true);
    expect(state.canArchive).toBe(true);
  });

  it("disables actions when the host is offline", () => {
    const state = deriveAgentActionSheetState(makeAggregatedAgent(), true);

    expect(state.title).toBe("Host offline");
    expect(state.canRecover).toBe(false);
    expect(state.canArchive).toBe(false);
  });
});
