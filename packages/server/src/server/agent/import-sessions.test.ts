import { beforeEach, expect, test, vi } from "vitest";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { FetchRecentProviderSessionsRequestMessage } from "../../shared/messages.js";
import type { AgentTimelineItem, PersistedAgentDescriptor } from "./agent-sdk-types.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./import-sessions.js";

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

function makeDescriptor(args: {
  provider?: string;
  sessionId: string;
  nativeHandle?: string;
  cwd?: string;
  title?: string | null;
  lastActivityAt: string;
  firstPrompt?: string;
  lastPrompt?: string;
}): PersistedAgentDescriptor {
  const provider = args.provider ?? "codex";
  const cwd = args.cwd ?? "/tmp/project";
  return {
    provider,
    sessionId: args.sessionId,
    cwd,
    title: args.title ?? null,
    lastActivityAt: new Date(args.lastActivityAt),
    persistence: {
      provider,
      sessionId: args.sessionId,
      ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
      metadata: { provider, cwd },
    },
    timeline: [
      ...(args.firstPrompt ? [{ type: "user_message" as const, text: args.firstPrompt }] : []),
      ...(args.lastPrompt ? [{ type: "user_message" as const, text: args.lastPrompt }] : []),
    ],
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
  const descriptors = [
    makeDescriptor({
      sessionId: "outside-cwd",
      nativeHandle: "outside-cwd-handle",
      cwd: "/tmp/elsewhere",
      title: "Outside cwd",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
    }),
    makeDescriptor({
      sessionId: "stored-session",
      nativeHandle: "stored-handle",
      cwd,
      title: "Already stored",
      lastActivityAt: "2026-04-30T12:04:00.000Z",
    }),
    makeDescriptor({
      sessionId: "older-session",
      nativeHandle: "older-handle",
      cwd,
      title: "Older than since",
      lastActivityAt: "2026-04-29T23:59:59.000Z",
    }),
    makeDescriptor({
      sessionId: "newer-session",
      nativeHandle: "newer-handle",
      cwd,
      title: "Newer import",
      lastActivityAt: "2026-04-30T12:02:00.000Z",
      firstPrompt: "newer first prompt",
      lastPrompt: "newer last prompt",
    }),
    makeDescriptor({
      sessionId: "second-session",
      nativeHandle: "second-handle",
      cwd,
      title: "Second import",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "second prompt",
    }),
    makeDescriptor({
      sessionId: "third-session",
      nativeHandle: "third-handle",
      cwd,
      title: "Third import",
      lastActivityAt: "2026-04-30T11:59:00.000Z",
      firstPrompt: "third prompt",
    }),
    makeDescriptor({
      sessionId: "live-session",
      nativeHandle: "live-handle",
      cwd,
      title: "Already live",
      lastActivityAt: "2026-04-30T12:01:00.000Z",
    }),
  ];
  const listImportablePersistedAgents = vi.fn(async () => descriptors);
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
    listImportablePersistedAgents,
  } satisfies Pick<AgentManager, "listAgents" | "listImportablePersistedAgents">;
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
    providerRegistry: { codex: { label: "Codex" } },
  });

  expect(listImportablePersistedAgents).toHaveBeenCalledWith({
    limit: 200,
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

test("listImportableProviderSessions filters out metadata generation sessions", async () => {
  const cwd = "/tmp/project";
  const descriptors = [
    makeDescriptor({
      sessionId: "metadata-session",
      nativeHandle: "metadata-handle",
      cwd,
      title: "Generate metadata for a coding agent based on the user prom...",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
      firstPrompt:
        "Generate metadata for a coding agent based on the user prompt.\nTitle: short descriptive label (<= 40 chars).",
    }),
    makeDescriptor({
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
      listImportablePersistedAgents: async () => descriptors,
    } satisfies Pick<AgentManager, "listAgents" | "listImportablePersistedAgents">,
    agentStorage: {
      list: async () => [],
    } satisfies Pick<AgentStorage, "list">,
    providerRegistry: { codex: { label: "Codex" } },
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].providerHandleId).toBe("real-handle");
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions rejects invalid since values", async () => {
  await expect(
    listImportableProviderSessions({
      request: makeRequest({ since: "not-a-date" }),
      agentManager: {
        listAgents: () => [],
        listImportablePersistedAgents: async () => [],
      } satisfies Pick<AgentManager, "listAgents" | "listImportablePersistedAgents">,
      agentStorage: {
        list: async () => [],
      } satisfies Pick<AgentStorage, "list">,
      providerRegistry: {},
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

test("importProviderSession resumes by provider handle, hydrates the timeline, and applies title metadata", async () => {
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
  const descriptor = makeDescriptor({
    provider: "custom-codex",
    sessionId: "thread-imported",
    nativeHandle: "provider-thread-imported",
    cwd,
    title: null,
    firstPrompt: "Trace recent provider sessions",
    lastActivityAt: "2026-04-30T00:00:00.000Z",
  });
  const agentManager = {
    findPersistedAgent: vi.fn().mockResolvedValue(descriptor),
    resumeAgentFromPersistence: vi.fn().mockResolvedValue(snapshot),
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
    getTimeline: vi.fn().mockReturnValue(timeline),
    setTitle: vi.fn().mockResolvedValue(undefined),
    notifyAgentState: vi.fn(),
  } as unknown as AgentManager;
  const agentStorage = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as AgentStorage;
  const scheduleAgentMetadataGeneration = vi.fn();

  const result = await importProviderSession({
    request: {
      requestId: "import-thread",
      provider: "custom-codex",
      providerHandleId: "provider-thread-imported",
      cwd,
    },
    agentManager,
    agentStorage,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
    deps: { scheduleAgentMetadataGeneration },
  });

  expect(agentManager.findPersistedAgent).toHaveBeenCalledWith(
    "custom-codex",
    "provider-thread-imported",
  );
  expect(agentManager.resumeAgentFromPersistence).toHaveBeenCalledWith(
    descriptor.persistence,
    { cwd },
    undefined,
    { labels: undefined },
  );
  expect(agentManager.hydrateTimelineFromProvider).toHaveBeenCalledWith(snapshot.id);
  expect(agentManager.setTitle).toHaveBeenCalledWith(snapshot.id, "Trace recent provider sessions");
  expect(scheduleAgentMetadataGeneration).toHaveBeenCalledWith(
    expect.objectContaining({
      agentManager,
      agentId: snapshot.id,
      cwd,
      initialPrompt: "Trace recent provider sessions\n\nkeep it tight",
      explicitTitle: null,
    }),
  );
  expect(result).toEqual({ snapshot, timelineSize: 2 });
});

test("importProviderSession builds a fallback handle when a non-OpenCode provider has no descriptor", async () => {
  const cwd = "/tmp/imported-agent";
  const snapshot = makeManagedAgent({
    provider: "codex",
    cwd,
    sessionId: "thread-imported",
    nativeHandle: "thread-imported",
  });
  const agentManager = {
    findPersistedAgent: vi.fn().mockResolvedValue(null),
    resumeAgentFromPersistence: vi.fn().mockResolvedValue(snapshot),
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
    getTimeline: vi.fn().mockReturnValue([]),
    setTitle: vi.fn().mockResolvedValue(undefined),
    notifyAgentState: vi.fn(),
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
    },
    agentManager,
    agentStorage,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  });

  expect(agentManager.resumeAgentFromPersistence).toHaveBeenCalledWith(
    {
      provider: "codex",
      sessionId: "thread-imported",
      nativeHandle: "thread-imported",
      metadata: { provider: "codex", cwd },
    },
    { cwd },
    undefined,
    { labels: undefined },
  );
});

test("importProviderSession requires cwd for missing OpenCode descriptors", async () => {
  const agentManager = {
    findPersistedAgent: vi.fn().mockResolvedValue(null),
  } as unknown as AgentManager;

  await expect(
    importProviderSession({
      request: {
        requestId: "import-thread",
        provider: "opencode",
        providerHandleId: "thread-imported",
      },
      agentManager,
      agentStorage: { list: vi.fn() } as unknown as AgentStorage,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
    }),
  ).rejects.toThrow(
    "OpenCode sessions require --cwd when the session cannot be found in persisted agents",
  );
});
