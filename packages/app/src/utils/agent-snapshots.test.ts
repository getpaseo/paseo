import { describe, expect, it } from "vitest";

import { normalizeAgentSnapshot } from "./agent-snapshots";

describe("normalizeAgentSnapshot", () => {
  it("falls back to runtime and persistence titles when snapshot.title is missing", () => {
    const normalized = normalizeAgentSnapshot(
      {
        id: "agent-1",
        provider: "codex",
        status: "closed",
        createdAt: "2026-04-12T10:00:00.000Z",
        updatedAt: "2026-04-12T10:00:01.000Z",
        lastUserMessageAt: null,
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: false,
          supportsMcpServers: false,
          supportsReasoningStream: false,
          supportsToolInvocations: false,
        },
        currentModeId: null,
        availableModes: [],
        pendingPermissions: [],
        persistence: {
          provider: "codex",
          sessionId: "tmux-session",
          metadata: {
            title: "Persisted Title",
            paneTitle: "tmux-pane-label",
          },
        },
        runtimeInfo: {
          provider: "codex",
          sessionId: "tmux-session",
          model: null,
          modeId: "auto",
          extra: {
            title: "Runtime Title",
          },
        },
        lastUsage: undefined,
        lastError: undefined,
        title: null,
        cwd: "/workspace/project",
        model: null,
        thinkingOptionId: null,
        requiresAttention: false,
        attentionReason: null,
        attentionTimestamp: null,
        archivedAt: null,
        labels: {},
      },
      "server-1",
    );

    expect(normalized.title).toBe("Runtime Title");
  });

  it("falls back to the persisted tmux pane title when no richer title exists", () => {
    const normalized = normalizeAgentSnapshot(
      {
        id: "agent-2",
        provider: "codex",
        status: "closed",
        createdAt: "2026-04-12T10:00:00.000Z",
        updatedAt: "2026-04-12T10:00:01.000Z",
        lastUserMessageAt: null,
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: false,
          supportsMcpServers: false,
          supportsReasoningStream: false,
          supportsToolInvocations: false,
        },
        currentModeId: null,
        availableModes: [],
        pendingPermissions: [],
        persistence: {
          provider: "codex",
          sessionId: "tmux-session",
          metadata: {
            paneTitle: "renamed-in-tmux",
          },
        },
        runtimeInfo: {
          provider: "codex",
          sessionId: "tmux-session",
          model: null,
          modeId: "auto",
          extra: {},
        },
        lastUsage: undefined,
        lastError: undefined,
        title: null,
        cwd: "/workspace/project",
        model: null,
        thinkingOptionId: null,
        requiresAttention: false,
        attentionReason: null,
        attentionTimestamp: null,
        archivedAt: null,
        labels: {},
      },
      "server-1",
    );

    expect(normalized.title).toBe("renamed-in-tmux");
  });
});
