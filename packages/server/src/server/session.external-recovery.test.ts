import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "./session.js";

function createLogger() {
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createSessionForExternalRecoveryTests(input: {
  onMessage: (message: any) => void;
  agentStorage: {
    get: (agentId: string) => Promise<any>;
    list: () => Promise<any[]>;
  };
  agentManager?: Partial<Session["agentManager"]>;
  tmuxCodexBridge?: any;
  codexProcessBridge?: any;
}): Session {
  const logger = createLogger();
  const agentManager = {
    subscribe: () => () => {},
    listAgents: () => [],
    getAgent: () => null,
    archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
    clearAgentAttention: async () => {},
    notifyAgentState: () => {},
    fetchTimeline: () => ({
      rows: [],
      hasOlder: false,
      hasNewer: false,
      reset: false,
      staleCursor: false,
      gap: false,
      window: {
        minSeq: 0,
        maxSeq: 0,
        nextSeq: 0,
      },
    }),
    hydrateTimelineFromProvider: async () => {},
    ...input.agentManager,
  };

  return new Session({
    clientId: "test-client",
    appVersion: "0.1.54",
    onMessage: input.onMessage,
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: agentManager as any,
    agentStorage: input.agentStorage as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    chatService: {} as any,
    scheduleService: {} as any,
    loopService: {} as any,
    checkoutDiffManager: {
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    } as any,
    backgroundGitFetchManager: {
      subscribe: () => () => {},
      scheduleRefreshForCwd: () => {},
    } as any,
    daemonConfigStore: {
      get: () => ({}),
      onChange: () => () => {},
    } as any,
    tmuxCodexBridge: input.tmuxCodexBridge as any,
    codexProcessBridge: input.codexProcessBridge as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  } as any);
}

function createManagedAgent(input: {
  id: string;
  cwd: string;
  title?: string;
  persistence?: Record<string, unknown> | null;
}): any {
  const now = new Date("2026-04-12T12:00:00.000Z");
  const title = input.title ?? `project [${input.id}]`;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    config: {
      provider: "codex",
      cwd: input.cwd,
      modeId: "auto",
      title,
    },
    runtimeInfo: {
      provider: "codex",
      sessionId: "managed-session-id",
      modeId: "auto",
      extra: {
        externalSessionSource: "tmux_codex",
        paneId: "%42",
      },
    },
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lifecycle: "idle",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "auto",
    availableModes: [],
    features: [],
    pendingPermissions: new Map(),
    persistence: (input.persistence ?? null) as any,
    labels: {
      source: "external",
      bridge: "codex_process",
      tty: "pts/7",
    },
    lastUsage: undefined,
    lastError: undefined,
    attention: {
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: now,
    },
  };
}

describe("external bridged session recovery", () => {
  let tempDir: string;
  let originalSessionDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-external-recovery-"));
    originalSessionDir = process.env.CODEX_SESSION_DIR;
  });

  afterEach(() => {
    if (originalSessionDir === undefined) {
      delete process.env.CODEX_SESSION_DIR;
    } else {
      process.env.CODEX_SESSION_DIR = originalSessionDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fetch_agent_timeline_request reopens a closed external codex session through tmux", async () => {
    const codexSessionId = "019d43f3-7c14-79e2-bffa-16aa4dd81ca3";
    const sessionRoot = join(tempDir, "codex-sessions");
    process.env.CODEX_SESSION_DIR = sessionRoot;

    const rolloutDir = join(sessionRoot, "2026", "04", "12");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, `rollout-2026-04-12T00-00-00-${codexSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-04-12T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "persisted history should not short-circuit" }],
        },
      })}\n`,
      "utf8",
    );

    const storedRecord = {
      id: "agent-external-closed",
      provider: "codex",
      cwd: "/workspace/project",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:10:00.000Z",
      lastActivityAt: "2026-04-12T00:10:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "closed",
      lastModeId: "auto",
      runtimeInfo: {
        provider: "codex",
        sessionId: codexSessionId,
        model: null,
        modeId: "auto",
        extra: {
          externalSessionSource: "codex_process",
          tty: "/dev/pts/7",
        },
      },
      config: {
        provider: "codex",
        cwd: "/workspace/project",
        modeId: "auto",
        title: "project [pts/7]",
      },
      persistence: {
        provider: "codex",
        sessionId: codexSessionId,
        metadata: {
          externalSessionSource: "codex_process",
          tty: "/dev/pts/7",
          sessionId: codexSessionId,
          cwd: "/workspace/project",
        },
      },
      title: "project [pts/7]",
      labels: { bridge: "codex_process", source: "external", tty: "pts/7" },
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };

    const relaunchedAgent = createManagedAgent({
      id: storedRecord.id,
      cwd: storedRecord.cwd,
      title: storedRecord.title,
      persistence: {
        provider: "codex",
        sessionId: "%42",
        metadata: {
          externalSessionSource: "tmux_codex",
          paneId: "%42",
          cwd: storedRecord.cwd,
        },
      },
    });
    const codexProcessBridge = {
      resumeFromPersistence: vi
        .fn()
        .mockRejectedValue(new Error("codex process session not found for /dev/pts/7")),
    };
    const tmuxCodexBridge = {
      relaunchFromPersistence: vi.fn().mockResolvedValue(relaunchedAgent),
    };

    const emitted: any[] = [];
    const session = createSessionForExternalRecoveryTests({
      onMessage: (message) => emitted.push(message),
      agentStorage: {
        get: async (agentId: string) => (agentId === storedRecord.id ? storedRecord : null),
        list: async () => [storedRecord],
      },
      agentManager: {
        fetchTimeline: () => ({
          rows: [],
          hasOlder: false,
          hasNewer: false,
          reset: false,
          staleCursor: false,
          gap: false,
          window: {
            minSeq: 0,
            maxSeq: 0,
            nextSeq: 0,
          },
        }),
      } as any,
      codexProcessBridge: codexProcessBridge as any,
      tmuxCodexBridge: tmuxCodexBridge as any,
    });

    await session.handleMessage({
      type: "fetch_agent_timeline_request",
      agentId: storedRecord.id,
      requestId: "timeline-reopen",
      direction: "tail",
      limit: 20,
      projection: "canonical",
    });

    expect(codexProcessBridge.resumeFromPersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: storedRecord.id,
        handle: expect.objectContaining({
          sessionId: codexSessionId,
        }),
      }),
    );
    expect(tmuxCodexBridge.relaunchFromPersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: storedRecord.id,
        handle: expect.objectContaining({
          sessionId: codexSessionId,
        }),
      }),
    );

    const response = emitted.find((message) => message.type === "fetch_agent_timeline_response");
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.agent?.id).toBe(storedRecord.id);
    expect(response?.payload.agent?.persistence?.metadata?.externalSessionSource).toBe("tmux_codex");
  });

  test("refresh_agent_request relaunches a closed external codex session through tmux", async () => {
    const codexSessionId = "019d7f5b-1d2c-76c2-96e9-0a6496559b68";
    const storedRecord = {
      id: "agent-external-refresh",
      provider: "codex",
      cwd: "/workspace/project",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:10:00.000Z",
      lastActivityAt: "2026-04-12T00:10:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "closed",
      lastModeId: "auto",
      runtimeInfo: {
        provider: "codex",
        sessionId: codexSessionId,
        model: null,
        modeId: "auto",
        extra: {
          externalSessionSource: "codex_process",
          tty: "/dev/pts/2",
          sessionId: codexSessionId,
        },
      },
      config: {
        provider: "codex",
        cwd: "/workspace/project",
        modeId: "auto",
        title: "project [tmux:%2]",
      },
      persistence: {
        provider: "codex",
        sessionId: codexSessionId,
        metadata: {
          externalSessionSource: "codex_process",
          tty: "/dev/pts/2",
          sessionId: codexSessionId,
          cwd: "/workspace/project",
        },
      },
      title: "project [pts/2]",
      labels: { bridge: "codex_process", source: "external", tty: "pts/2" },
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };

    const relaunchedAgent = createManagedAgent({
      id: storedRecord.id,
      cwd: storedRecord.cwd,
      title: "project [tmux:%42]",
      persistence: {
        provider: "codex",
        sessionId: "%42",
        metadata: {
          externalSessionSource: "tmux_codex",
          paneId: "%42",
          cwd: storedRecord.cwd,
          sessionId: codexSessionId,
        },
      },
    });

    const codexProcessBridge = {
      resumeFromPersistence: vi
        .fn()
        .mockRejectedValue(new Error("codex process session not found for /dev/pts/2")),
    };
    const tmuxCodexBridge = {
      relaunchFromPersistence: vi.fn().mockResolvedValue(relaunchedAgent),
    };

    const emitted: any[] = [];
    const session = createSessionForExternalRecoveryTests({
      onMessage: (message) => emitted.push(message),
      agentStorage: {
        get: async (agentId: string) => (agentId === storedRecord.id ? storedRecord : null),
        list: async () => [storedRecord],
      },
      agentManager: {
        getTimeline: () => [],
      } as any,
      codexProcessBridge: codexProcessBridge as any,
      tmuxCodexBridge: tmuxCodexBridge as any,
    });

    await session.handleMessage({
      type: "refresh_agent_request",
      agentId: storedRecord.id,
      requestId: "refresh-external",
    });

    expect(codexProcessBridge.resumeFromPersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: storedRecord.id,
        handle: expect.objectContaining({
          sessionId: codexSessionId,
        }),
      }),
    );
    expect(tmuxCodexBridge.relaunchFromPersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: storedRecord.id,
        config: expect.objectContaining({
          title: "project [pts/2]",
        }),
        handle: expect.objectContaining({
          sessionId: codexSessionId,
        }),
      }),
    );

    const refreshed = emitted.find(
      (message) =>
        message.type === "status" &&
        message.payload?.status === "agent_refreshed" &&
        message.payload?.requestId === "refresh-external",
    );
    expect(refreshed?.payload.agentId).toBe(storedRecord.id);
  });

  test("fetch_agents_request resolves live tmux session titles from renamed pane metadata", async () => {
    const storedRecord = {
      id: "agent-live-tmux",
      provider: "codex",
      cwd: "/workspace/project",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:10:00.000Z",
      lastActivityAt: "2026-04-12T00:10:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle",
      lastModeId: "auto",
      runtimeInfo: {
        provider: "codex",
        sessionId: "%42",
        model: null,
        modeId: "auto",
        extra: {
          externalSessionSource: "tmux_codex",
          paneId: "%42",
          title: "Renamed pane title",
        },
      },
      config: {
        provider: "codex",
        cwd: "/workspace/project",
        modeId: "auto",
        title: "Renamed pane title",
        extra: {
          codex: {
            externalSessionSource: "tmux_codex",
            paneId: "%42",
          },
        },
      },
      persistence: {
        provider: "codex",
        sessionId: "%42",
        metadata: {
          externalSessionSource: "tmux_codex",
          paneId: "%42",
          paneTitle: "Renamed pane title",
          title: "Renamed pane title",
          cwd: "/workspace/project",
        },
      },
      title: "project [tmux:%42]",
      labels: { bridge: "codex", source: "tmux", pane: "%42" },
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };
    const liveAgent = {
      ...createManagedAgent({
        id: storedRecord.id,
        cwd: storedRecord.cwd,
        title: storedRecord.config.title,
        persistence: storedRecord.persistence,
      }),
      labels: storedRecord.labels,
      runtimeInfo: storedRecord.runtimeInfo,
    };

    const emitted: any[] = [];
    const session = createSessionForExternalRecoveryTests({
      onMessage: (message) => emitted.push(message),
      agentStorage: {
        get: async (agentId: string) => (agentId === storedRecord.id ? storedRecord : null),
        list: async () => [storedRecord],
      },
      agentManager: {
        listAgents: () => [liveAgent],
        getAgent: (agentId: string) => (agentId === storedRecord.id ? liveAgent : null),
      } as any,
    });

    await session.handleMessage({
      type: "fetch_agents_request",
      requestId: "fetch-live-tmux",
    });

    const response = emitted.find((message) => message.type === "fetch_agents_response");
    expect(response?.payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: expect.objectContaining({
            id: storedRecord.id,
            title: "Renamed pane title",
          }),
        }),
      ]),
    );
  });
});
