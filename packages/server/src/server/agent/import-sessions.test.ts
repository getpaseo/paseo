import { beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentManager,
  ManagedAgent,
  ManagedImportableProviderSession,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { FetchRecentProviderSessionsRequestMessage } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./import-sessions.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

const TEST_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeImportableSession(args: {
  provider?: string;
  sessionId: string;
  nativeHandle?: string;
  cwd?: string;
  title?: string | null;
  lastActivityAt: string;
  firstPrompt?: string;
  lastPrompt?: string;
}): ManagedImportableProviderSession {
  const provider = args.provider ?? "codex";
  const cwd = args.cwd ?? "/tmp/project";
  return {
    provider,
    providerHandleId: args.nativeHandle ?? args.sessionId,
    cwd,
    title: args.title ?? null,
    lastActivityAt: new Date(args.lastActivityAt),
    firstPromptPreview: args.firstPrompt ?? null,
    lastPromptPreview: args.lastPrompt ?? args.firstPrompt ?? null,
  };
}

function makeManagedAgent(args: {
  id?: string;
  provider?: string;
  cwd: string;
  sessionId: string;
  nativeHandle?: string;
  title?: string | null;
}): ManagedAgent {
  const provider = args.provider ?? "codex";
  return {
    id: args.id ?? "00000000-0000-4000-8000-000000000632",
    provider,
    cwd: args.cwd,
    capabilities: TEST_CAPABILITIES,
    config: { provider, cwd: args.cwd, title: args.title },
    createdAt: new Date("2026-04-30T00:00:00.000Z"),
    updatedAt: new Date("2026-04-30T00:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: {
      provider,
      sessionId: args.sessionId,
      ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
      metadata: { provider, cwd: args.cwd },
    },
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    internal: false,
    labels: {},
    lifecycle: "closed",
    session: null,
    activeForegroundTurnId: null,
  } satisfies ManagedAgent;
}

function createUnarchiveGate() {
  let allowUnarchive: () => void = () => {};
  const unarchiveAllowed = new Promise<void>((resolve) => {
    allowUnarchive = resolve;
  });

  return {
    holdUnarchive: () => unarchiveAllowed,
    allowUnarchive,
  };
}

function makeRequest(
  overrides: Partial<FetchRecentProviderSessionsRequestMessage> = {},
): FetchRecentProviderSessionsRequestMessage {
  return {
    type: "fetch_recent_provider_sessions_request",
    requestId: "recent-provider-sessions",
    ...overrides,
  };
}

test("listImportableProviderSessions filters, sorts, limits, and projects importable sessions", async () => {
  const cwd = "/tmp/project";
  const sessions = [
    makeImportableSession({
      sessionId: "outside-cwd",
      nativeHandle: "outside-cwd-handle",
      cwd: "/tmp/elsewhere",
      title: "Outside cwd",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
    }),
    makeImportableSession({
      sessionId: "stored-session",
      nativeHandle: "stored-handle",
      cwd,
      title: "Already stored",
      lastActivityAt: "2026-04-30T12:04:00.000Z",
      firstPrompt: "stored prompt",
    }),
    makeImportableSession({
      sessionId: "older-session",
      nativeHandle: "older-handle",
      cwd,
      title: "Older than since",
      lastActivityAt: "2026-04-29T23:59:59.000Z",
    }),
    makeImportableSession({
      sessionId: "newer-session",
      nativeHandle: "newer-handle",
      cwd,
      title: "Newer import",
      lastActivityAt: "2026-04-30T12:02:00.000Z",
      firstPrompt: "newer first prompt",
      lastPrompt: "newer last prompt",
    }),
    makeImportableSession({
      sessionId: "second-session",
      nativeHandle: "second-handle",
      cwd,
      title: "Second import",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "second prompt",
    }),
    makeImportableSession({
      sessionId: "third-session",
      nativeHandle: "third-handle",
      cwd,
      title: "Third import",
      lastActivityAt: "2026-04-30T11:59:00.000Z",
      firstPrompt: "third prompt",
    }),
    makeImportableSession({
      sessionId: "live-session",
      nativeHandle: "live-handle",
      cwd,
      title: "Already live",
      lastActivityAt: "2026-04-30T12:01:00.000Z",
      firstPrompt: "live prompt",
    }),
  ];
  const listImportableSessions = vi.fn(async () => sessions);
  const agentManager = {
    listAgents: () =>
      [
        {
          provider: "codex",
          persistence: {
            provider: "codex",
            sessionId: "live-session",
            nativeHandle: "live-handle",
          },
        },
      ] as ManagedAgent[],
    listImportableSessions,
  } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">;
  const agentStorage = {
    list: async () => [
      {
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "stored-session",
          nativeHandle: "stored-handle",
        },
      } as StoredAgentRecord,
    ],
  } satisfies Pick<AgentStorage, "list">;

  const result = await listImportableProviderSessions({
    request: makeRequest({
      cwd,
      providers: ["codex"],
      since: "2026-04-30T00:00:00.000Z",
      limit: 2,
    }),
    agentManager,
    agentStorage,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(listImportableSessions).toHaveBeenCalledWith({
    limit: 2,
    providerFilter: new Set(["codex"]),
    cwd,
  });
  expect(result).toEqual({
    filteredAlreadyImportedCount: 2,
    entries: [
      {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: "newer-handle",
        cwd,
        title: "Newer import",
        firstPromptPreview: "newer first prompt",
        lastPromptPreview: "newer last prompt",
        lastActivityAt: "2026-04-30T12:02:00.000Z",
      },
      {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: "second-handle",
        cwd,
        title: "Second import",
        firstPromptPreview: "second prompt",
        lastPromptPreview: "second prompt",
        lastActivityAt: "2026-04-30T12:00:00.000Z",
      },
    ],
  });
});

test("listImportableProviderSessions includes a provider session after its Paseo agent is archived", async () => {
  const cwd = "/tmp/project";
  const archivedSession = makeImportableSession({
    provider: "claude",
    sessionId: "archived-session",
    cwd,
    title: "Archived import",
    lastActivityAt: "2026-04-30T12:00:00.000Z",
    firstPrompt: "import me again",
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["claude"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [archivedSession],
    },
    agentStorage: {
      list: async () => [
        {
          provider: "claude",
          archivedAt: "2026-04-30T12:01:00.000Z",
          persistence: {
            provider: "claude",
            sessionId: "archived-session",
          },
        } as StoredAgentRecord,
      ],
    },
    providerSnapshotManager: { getProviderLabel: () => "Claude" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["archived-session"]);
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions includes an archived provider session still loaded in memory", async () => {
  const cwd = "/tmp/project";
  const agentId = "00000000-0000-4000-8000-000000000633";
  const archivedSession = makeImportableSession({
    provider: "claude",
    sessionId: "archived-live-session",
    cwd,
    title: "Archived live import",
    lastActivityAt: "2026-04-30T12:00:00.000Z",
    firstPrompt: "import the loaded session again",
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["claude"] }),
    agentManager: {
      listAgents: () => [
        makeManagedAgent({
          id: agentId,
          provider: "claude",
          cwd,
          sessionId: "archived-live-session",
        }),
      ],
      listImportableSessions: async () => [archivedSession],
    },
    agentStorage: {
      list: async () => [
        {
          id: agentId,
          provider: "claude",
          archivedAt: "2026-04-30T12:01:00.000Z",
          persistence: {
            provider: "claude",
            sessionId: "archived-live-session",
          },
        } as StoredAgentRecord,
      ],
    },
    providerSnapshotManager: { getProviderLabel: () => "Claude" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["archived-live-session"]);
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions filters out metadata generation sessions", async () => {
  const cwd = "/tmp/project";
  const sessions = [
    makeImportableSession({
      sessionId: "metadata-session",
      nativeHandle: "metadata-handle",
      cwd,
      title: "Generate metadata for a coding agent based on the user prom...",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
      firstPrompt:
        "Generate metadata for a coding agent based on the user prompt.\nTitle: short descriptive label (<= 40 chars).",
    }),
    makeImportableSession({
      sessionId: "real-session",
      nativeHandle: "real-handle",
      cwd,
      title: "Real session",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "hey hey",
    }),
  ];

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["codex"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => sessions,
    } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">,
    agentStorage: {
      list: async () => [],
    } satisfies Pick<AgentStorage, "list">,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].providerHandleId).toBe("real-handle");
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions keeps realpath-equivalent cwd matches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-import-cwd-"));
  const realCwd = path.join(root, "real-project");
  const linkedCwd = path.join(root, "linked-project");
  mkdirSync(realCwd, { recursive: true });
  symlinkSync(realCwd, linkedCwd, directorySymlinkType);
  const persistedCwd = realpathSync(linkedCwd);

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd: linkedCwd, providers: ["pi"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [
        makeImportableSession({
          provider: "pi",
          sessionId: "pi-session",
          nativeHandle: "pi-handle",
          cwd: persistedCwd,
          title: "Pi session",
          lastActivityAt: "2026-04-30T12:00:00.000Z",
          firstPrompt: "remember this",
        }),
      ],
    } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">,
    agentStorage: {
      list: async () => [],
    } satisfies Pick<AgentStorage, "list">,
    providerSnapshotManager: { getProviderLabel: () => "Pi" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["pi-handle"]);
});

test("listImportableProviderSessions rejects invalid since values", async () => {
  await expect(
    listImportableProviderSessions({
      request: makeRequest({ since: "not-a-date" }),
      agentManager: {
        listAgents: () => [],
        listImportableSessions: async () => [],
      } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">,
      agentStorage: {
        list: async () => [],
      } satisfies Pick<AgentStorage, "list">,
      providerSnapshotManager: { getProviderLabel: () => "" },
    }),
  ).rejects.toMatchObject(
    new ImportSessionsRequestError("invalid_since", "Invalid recent provider sessions since"),
  );
});

test("normalizeImportAgentRequest accepts new and legacy import handle shapes", () => {
  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "new-shape",
      providerId: "custom-codex",
      providerHandleId: "thread-1",
    }),
  ).toEqual({
    requestId: "new-shape",
    provider: "custom-codex",
    providerHandleId: "thread-1",
  });

  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "legacy-shape",
      provider: "codex",
      sessionId: "thread-2",
    }),
  ).toEqual({
    requestId: "legacy-shape",
    provider: "codex",
    providerHandleId: "thread-2",
  });
});

test("importProviderSession imports a selected provider session without listing", async () => {
  const cwd = "/tmp/imported-agent";
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "Trace recent provider sessions\n\nkeep it tight" },
    { type: "assistant_message", text: "I will inspect the provider listing." },
  ];
  const snapshot = makeManagedAgent({
    id: "00000000-0000-4000-8000-000000000633",
    provider: "custom-codex",
    cwd,
    sessionId: "thread-imported",
    nativeHandle: "provider-thread-imported",
    title: null,
  });
  const agentManager = {
    importProviderSession: vi.fn().mockResolvedValue(snapshot),
    getTimeline: vi.fn().mockReturnValue(timeline),
    unarchiveSnapshot: vi.fn().mockResolvedValue(false),
  } as unknown as AgentManager;
  const agentStorage = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as AgentStorage;

  const result = await importProviderSession({
    request: {
      requestId: "import-thread",
      provider: "custom-codex",
      providerHandleId: "provider-thread-imported",
      cwd,
    },
    workspaceId: "ws-imported",
    agentManager,
    agentStorage,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });

  expect(agentManager.importProviderSession).toHaveBeenCalledWith({
    provider: "custom-codex",
    providerHandleId: "provider-thread-imported",
    cwd,
    workspaceId: "ws-imported",
    labels: undefined,
  });
  expect(result).toEqual({ snapshot, timelineSize: 2 });
});

test("importProviderSession passes labels through the manager import operation", async () => {
  const cwd = "/tmp/imported-agent";
  const snapshot = makeManagedAgent({
    provider: "codex",
    cwd,
    sessionId: "thread-imported",
    nativeHandle: "thread-imported",
  });
  const agentManager = {
    importProviderSession: vi.fn().mockResolvedValue(snapshot),
    getTimeline: vi.fn().mockReturnValue([]),
    unarchiveSnapshot: vi.fn().mockResolvedValue(false),
  } as unknown as AgentManager;
  const agentStorage = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as AgentStorage;

  await importProviderSession({
    request: {
      requestId: "import-thread",
      provider: "codex",
      providerHandleId: "thread-imported",
      cwd,
      labels: { source: "import" },
    },
    workspaceId: "ws-imported",
    agentManager,
    agentStorage,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });

  expect(agentManager.importProviderSession).toHaveBeenCalledWith({
    provider: "codex",
    providerHandleId: "thread-imported",
    cwd,
    workspaceId: "ws-imported",
    labels: { source: "import" },
  });
});

test("importProviderSession restores an archived subagent as the same standalone Paseo agent", async () => {
  const cwd = "/tmp/imported-agent";
  const agentId = "00000000-0000-4000-8000-000000000634";
  const persistence = {
    provider: "codex",
    sessionId: "thread-archived",
    nativeHandle: "thread-archived",
    metadata: { provider: "codex", cwd },
  };
  const archivedRecord = {
    id: agentId,
    provider: "codex",
    cwd,
    workspaceId: "ws-archived",
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T11:00:00.000Z",
    lastActivityAt: "2026-04-30T10:30:00.000Z",
    lastUserMessageAt: null,
    labels: { existing: "label", [PARENT_AGENT_ID_LABEL]: "archived-parent" },
    config: { provider: "codex", cwd },
    persistence,
    archivedAt: "2026-04-30T12:00:00.000Z",
  } as StoredAgentRecord;
  const snapshot = makeManagedAgent({
    id: agentId,
    provider: "codex",
    cwd,
    sessionId: "thread-archived",
    nativeHandle: "thread-archived",
  });
  let freshImportAttempted = false;
  let unarchivedAgentId: string | undefined;
  let unarchiveUpdates:
    | { workspaceId?: string; labels?: Record<string, string | null> }
    | undefined;
  let resumedAgentId: string | undefined;
  let resumeOptions: { workspaceId?: string; labels?: Record<string, string> } | undefined;
  const agentManager = {
    importProviderSession: async () => {
      freshImportAttempted = true;
      return snapshot;
    },
    unarchiveSnapshot: async (
      id: string,
      updates?: { workspaceId?: string; labels?: Record<string, string | null> },
    ) => {
      unarchivedAgentId = id;
      unarchiveUpdates = updates;
      return true;
    },
    notifyAgentState: () => {},
    resumeAgentFromPersistence: async (
      _handle: unknown,
      _overrides: unknown,
      id?: string,
      options?: { workspaceId?: string; labels?: Record<string, string> },
    ) => {
      resumedAgentId = id;
      resumeOptions = options;
      return snapshot;
    },
    hydrateTimelineFromProvider: async () => {},
    getTimeline: () => [{ type: "user_message", text: "restored" }],
  } as unknown as AgentManager;
  const agentStorage = {
    list: async () => [archivedRecord],
  } as unknown as AgentStorage;

  const result = await importProviderSession({
    request: {
      requestId: "reimport-thread",
      provider: "codex",
      providerHandleId: "thread-archived",
      cwd,
      labels: { source: "reimport" },
    },
    workspaceId: "ws-restored",
    agentManager,
    agentStorage,
    logger: { warn: () => {}, error: () => {} } as never,
  });

  expect(freshImportAttempted).toBe(false);
  expect(unarchivedAgentId).toBe(agentId);
  expect(unarchiveUpdates).toEqual({
    workspaceId: "ws-restored",
    labels: { [PARENT_AGENT_ID_LABEL]: null, source: "reimport" },
  });
  expect(resumedAgentId).toBe(agentId);
  expect(resumeOptions).toMatchObject({
    workspaceId: "ws-restored",
    labels: { existing: "label", source: "reimport" },
  });
  expect(resumeOptions?.labels).not.toHaveProperty(PARENT_AGENT_ID_LABEL);
  expect(result).toEqual({ snapshot, timelineSize: 1 });
});

test("importProviderSession restores the archived record when provider resume fails", async () => {
  const cwd = "/tmp/imported-agent";
  const agentId = "00000000-0000-4000-8000-000000000635";
  const archivedAt = "2026-04-30T12:00:00.000Z";
  const archivedRecord = {
    id: agentId,
    provider: "codex",
    cwd,
    workspaceId: "ws-archived",
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T11:00:00.000Z",
    lastActivityAt: "2026-04-30T10:30:00.000Z",
    lastUserMessageAt: null,
    labels: { existing: "label" },
    config: { provider: "codex", cwd },
    persistence: {
      provider: "codex",
      sessionId: "thread-stale",
      nativeHandle: "thread-stale",
      metadata: { provider: "codex", cwd },
    },
    archivedAt,
  } as StoredAgentRecord;
  let rearchivedAgentId: string | undefined;
  let rearchivedAt: string | undefined;
  let restoredRecord: StoredAgentRecord | undefined;
  const agentManager = {
    importProviderSession: async () => {
      throw new Error("fresh import should not run");
    },
    unarchiveSnapshot: async () => true,
    notifyAgentState: () => {},
    resumeAgentFromPersistence: async () => {
      throw new Error("provider session is unavailable");
    },
    getAgent: () => null,
    archiveSnapshot: async (id: string, timestamp: string) => {
      rearchivedAgentId = id;
      rearchivedAt = timestamp;
      return archivedRecord;
    },
  } as unknown as AgentManager;
  const agentStorage = {
    list: async () => [archivedRecord],
    upsert: async (record: StoredAgentRecord) => {
      restoredRecord = record;
    },
  } as unknown as AgentStorage;

  await expect(
    importProviderSession({
      request: {
        requestId: "reimport-stale-thread",
        provider: "codex",
        providerHandleId: "thread-stale",
        cwd,
      },
      workspaceId: "ws-restored",
      agentManager,
      agentStorage,
      logger: { warn: () => {}, error: () => {} } as never,
    }),
  ).rejects.toThrow("provider session is unavailable");

  expect(rearchivedAgentId).toBe(agentId);
  expect(rearchivedAt).toBe(archivedAt);
  expect(restoredRecord).toBe(archivedRecord);
});

test("importProviderSession serializes legacy and native aliases for one archived session", async () => {
  const cwd = "/tmp/imported-agent";
  const agentId = "00000000-0000-4000-8000-000000000636";
  let storedRecord = {
    id: agentId,
    provider: "codex",
    cwd,
    workspaceId: "ws-archived",
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T11:00:00.000Z",
    lastActivityAt: "2026-04-30T10:30:00.000Z",
    lastUserMessageAt: null,
    labels: {},
    config: { provider: "codex", cwd },
    persistence: {
      provider: "codex",
      sessionId: "legacy-thread-concurrent",
      nativeHandle: "native-thread-concurrent",
      metadata: { provider: "codex", cwd },
    },
    archivedAt: "2026-04-30T12:00:00.000Z",
  } as StoredAgentRecord;
  const snapshot = makeManagedAgent({
    id: agentId,
    provider: "codex",
    cwd,
    sessionId: "legacy-thread-concurrent",
    nativeHandle: "native-thread-concurrent",
  });
  const unarchive = createUnarchiveGate();
  const closedAgentIds: string[] = [];
  let activeAgent: ManagedAgent | null = null;
  let resumeAttempts = 0;
  const agentManager = {
    unarchiveSnapshot: async (_id: string, updates?: { workspaceId?: string }) => {
      await unarchive.holdUnarchive();
      storedRecord = {
        ...storedRecord,
        ...(updates?.workspaceId ? { workspaceId: updates.workspaceId } : {}),
        archivedAt: null,
      };
      return true;
    },
    notifyAgentState: () => {},
    resumeAgentFromPersistence: async () => {
      resumeAttempts += 1;
      if (resumeAttempts > 1) {
        throw new Error(`Agent with id ${agentId} already exists`);
      }
      activeAgent = snapshot;
      return snapshot;
    },
    hydrateTimelineFromProvider: async () => {},
    getTimeline: () => [],
    getAgent: () => activeAgent,
    closeAgent: async (id: string) => {
      closedAgentIds.push(id);
      activeAgent = null;
    },
    archiveSnapshot: async (_id: string, archivedAt: string) => {
      storedRecord = { ...storedRecord, archivedAt };
      return storedRecord;
    },
  } as unknown as AgentManager;
  const agentStorage = {
    list: async () => [{ ...storedRecord }],
    upsert: async (record: StoredAgentRecord) => {
      storedRecord = record;
    },
  } as unknown as AgentStorage;
  const input = {
    request: {
      requestId: "reimport-concurrent-thread",
      provider: "codex" as const,
      providerHandleId: "native-thread-concurrent",
      cwd,
    },
    workspaceId: "ws-restored",
    agentManager,
    agentStorage,
    logger: { warn: () => {}, error: () => {} } as never,
  };

  const winningRestore = importProviderSession(input);
  const duplicateRestore = importProviderSession({
    ...input,
    request: {
      ...input.request,
      providerHandleId: "legacy-thread-concurrent",
    },
  });
  unarchive.allowUnarchive();

  await expect(winningRestore).resolves.toEqual({ snapshot, timelineSize: 0 });
  await expect(duplicateRestore).rejects.toThrow(
    "Provider session is already imported: legacy-thread-concurrent",
  );
  expect(storedRecord.archivedAt).toBeNull();
  expect(closedAgentIds).toEqual([]);
});

test("importProviderSession requires cwd from the selected provider row", async () => {
  const agentManager = {} as unknown as AgentManager;

  await expect(
    importProviderSession({
      request: {
        requestId: "import-thread",
        provider: "opencode",
        providerHandleId: "thread-imported",
      },
      workspaceId: "ws-imported",
      agentManager,
      agentStorage: { list: vi.fn() } as unknown as AgentStorage,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
    }),
  ).rejects.toThrow("Import requires cwd from the selected provider session");
});
