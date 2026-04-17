import { describe, expect, it } from "vitest";

import type { Agent } from "@/stores/session-store";
import { describeExternalSessionRecovery } from "./external-session";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: "host-1",
    id: "agent-1",
    provider: "codex",
    status: "closed",
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:10:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-04-12T00:10:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: "auto",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    lastUsage: undefined,
    lastError: null,
    title: "project [pts/7]",
    cwd: "/workspace/project",
    model: null,
    features: [],
    thinkingOptionId: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    labels: {},
    projectPlacement: null,
    ...overrides,
  };
}

describe("describeExternalSessionRecovery", () => {
  it("treats a closed codex process with a real session id as resumable in tmux", () => {
    const descriptor = describeExternalSessionRecovery(
      createAgent({
        persistence: {
          provider: "codex",
          sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
          metadata: {
            externalSessionSource: "codex_process",
            tty: "/dev/pts/2",
            sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
          },
        },
        runtimeInfo: {
          provider: "codex",
          sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
          modeId: "auto",
          model: null,
          extra: {
            externalSessionSource: "codex_process",
            tty: "/dev/pts/2",
            sessionId: "019d7f5b-1d2c-76c2-96e9-0a6496559b68",
          },
        },
      }),
    );

    expect(descriptor.source).toBe("codex_process");
    expect(descriptor.isExternal).toBe(true);
    expect(descriptor.canRecoverWhenClosed).toBe(true);
    expect(descriptor.recoverableSessionId).toBe("019d7f5b-1d2c-76c2-96e9-0a6496559b68");
    expect(descriptor.restartLabel).toBe("Resume in tmux");
  });

  it("treats a closed codex process without a session id as a fresh tmux restart", () => {
    const descriptor = describeExternalSessionRecovery(
      createAgent({
        persistence: {
          provider: "codex",
          sessionId: "/dev/pts/24",
          metadata: {
            externalSessionSource: "codex_process",
            tty: "/dev/pts/24",
            sessionId: null,
          },
        },
        runtimeInfo: {
          provider: "codex",
          sessionId: "/dev/pts/24",
          modeId: "auto",
          model: null,
          extra: {
            externalSessionSource: "codex_process",
            tty: "/dev/pts/24",
            sessionId: null,
          },
        },
      }),
    );

    expect(descriptor.source).toBe("codex_process");
    expect(descriptor.canRecoverWhenClosed).toBe(true);
    expect(descriptor.recoverableSessionId).toBeNull();
    expect(descriptor.restartLabel).toBe("Restart in tmux");
  });

  it("does not mark live tmux sessions for closed-session recovery", () => {
    const descriptor = describeExternalSessionRecovery(
      createAgent({
        status: "idle",
        persistence: {
          provider: "codex",
          sessionId: "%4",
          metadata: {
            externalSessionSource: "tmux_codex",
            paneId: "%4",
            sessionId: "019d43f3-7c14-79e2-bffa-16aa4dd81ca3",
          },
        },
        runtimeInfo: {
          provider: "codex",
          sessionId: "019d43f3-7c14-79e2-bffa-16aa4dd81ca3",
          modeId: "auto",
          model: null,
          extra: {
            externalSessionSource: "tmux_codex",
            paneId: "%4",
          },
        },
      }),
    );

    expect(descriptor.source).toBe("tmux_codex");
    expect(descriptor.isExternal).toBe(true);
    expect(descriptor.canRecoverWhenClosed).toBe(false);
    expect(descriptor.restartLabel).toBe("Reopen tmux session");
  });

  it("ignores non-external agents", () => {
    const descriptor = describeExternalSessionRecovery(createAgent());

    expect(descriptor.source).toBeNull();
    expect(descriptor.isExternal).toBe(false);
    expect(descriptor.canRecoverWhenClosed).toBe(false);
    expect(descriptor.restartLabel).toBe("Restart terminal");
  });
});
