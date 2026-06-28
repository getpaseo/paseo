import { beforeAll, describe, expect, it } from "vitest";
import type {
  DaemonClient,
  FetchAgentHistoryEntry,
  FetchAgentHistoryOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentHistoryClient, AgentHistoryHost } from "./use-agent-history";
import { allAgentHistoryQueryKey } from "./agent-history-query-key";

(
  globalThis as unknown as {
    __DEV__: boolean;
  }
).__DEV__ = false;

type UseAgentHistoryModule = typeof import("./use-agent-history");

let fetchAgentHistoryBatch: UseAgentHistoryModule["fetchAgentHistoryBatch"];
let fetchAgentHistoryPage: UseAgentHistoryModule["fetchAgentHistoryPage"];

beforeAll(async () => {
  const module = await import("./use-agent-history");
  fetchAgentHistoryBatch = module.fetchAgentHistoryBatch;
  fetchAgentHistoryPage = module.fetchAgentHistoryPage;
});

type FetchAgentHistory = DaemonClient["fetchAgentHistory"];
type FetchAgentHistoryResult = Awaited<ReturnType<FetchAgentHistory>>;

interface FakeAgentHistoryClient extends AgentHistoryClient {
  calls: FetchAgentHistoryOptions[];
}

function createClient(pages: FetchAgentHistoryResult[]): FakeAgentHistoryClient {
  const calls: FetchAgentHistoryOptions[] = [];
  let index = 0;
  return {
    calls,
    fetchAgentHistory: async (options) => {
      calls.push(options ?? {});
      const page = pages[index] ?? pages[pages.length - 1];
      index += 1;
      if (!page) {
        throw new Error("No more history pages configured");
      }
      return page;
    },
  };
}

function createFailingClient(): FakeAgentHistoryClient {
  const calls: FetchAgentHistoryOptions[] = [];
  return {
    calls,
    fetchAgentHistory: async (options) => {
      calls.push(options ?? {});
      throw new Error("Host history failed");
    },
  };
}

function historyPayload(input: {
  entries: FetchAgentHistoryEntry[];
  hasMore?: boolean;
  nextCursor?: string | null;
}): FetchAgentHistoryResult {
  return {
    requestId: "req_history",
    entries: input.entries,
    pageInfo: {
      nextCursor: input.nextCursor ?? null,
      prevCursor: null,
      hasMore: input.hasMore ?? false,
    },
  };
}

function historyEntry(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  title?: string | null;
  archivedAt?: string | null;
}): FetchAgentHistoryEntry {
  return {
    agent: {
      id: input.id,
      provider: "codex",
      status: "closed",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
      lastUserMessageAt: null,
      lastError: undefined,
      runtimeInfo: {
        provider: "codex",
        sessionId: null,
      },
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
      title: input.title ?? null,
      cwd: input.cwd,
      model: null,
      thinkingOptionId: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: input.archivedAt ?? null,
      labels: {},
    },
    project: {
      projectKey: input.cwd,
      projectName: "workspace",
      checkout: {
        cwd: input.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

describe("fetchAgentHistoryPage", () => {
  it("builds the all-host query key independent of host order", () => {
    expect(allAgentHistoryQueryKey(["server-b", "server-a"])).toEqual(
      allAgentHistoryQueryKey(["server-a", "server-b"]),
    );
  });

  it("requests the first page with the default limit and updated_at descending sort", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-1",
            cwd: "/repo",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "History one",
          }),
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(client.calls).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200 },
      } satisfies FetchAgentHistoryOptions,
    ]);
    expect(page.agents.map((agent) => agent.id)).toEqual(["history-1"]);
    expect(page.pageInfo).toEqual({
      nextCursor: "cursor-2",
      prevCursor: null,
      hasMore: true,
    });
  });

  it("passes the cursor when fetching subsequent pages", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-2",
            cwd: "/repo",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "History two",
          }),
        ],
      }),
    ]);

    await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: "cursor-2" });

    expect(client.calls.at(-1)).toEqual({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "cursor-2" },
    } satisfies FetchAgentHistoryOptions);
  });

  it("maps daemon history entries into aggregated agents tagged with the requested server", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-1",
            cwd: "/repo",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "History one",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(page.agents).toEqual([
      expect.objectContaining({
        id: "history-1",
        serverId: "server-1",
        serverLabel: "server-1",
        title: "History one",
        cwd: "/repo",
        provider: "codex",
        archivedAt: null,
      }),
    ]);
  });

  it("carries archived entries through with their archivedAt timestamp", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-archived",
            cwd: "/repo",
            updatedAt: "2026-04-01T10:00:00.000Z",
            archivedAt: "2026-04-01T10:05:00.000Z",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(page.agents[0]?.archivedAt).toEqual(new Date("2026-04-01T10:05:00.000Z"));
  });

  it("fetches and sorts history across hosts with host labels", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "older-a",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Older A",
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "newer-b",
            cwd: "/repo/b",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "Newer B",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
    });

    expect(page.agents.map((agent) => `${agent.serverLabel}:${agent.id}`)).toEqual([
      "Linux box:newer-b",
      "MacBook:older-a",
    ]);
  });

  it("fetches only hosts with a cursor when loading the next all-host page", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "next-a",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "next-b",
            cwd: "/repo/b",
            updatedAt: "2026-04-02T10:00:00.000Z",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: { "server-b": "cursor-b" },
    });

    expect(page.agents.map((agent) => agent.id)).toEqual(["next-b"]);
    expect(serverAClient.calls).toEqual([]);
    expect(serverBClient.calls).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200, cursor: "cursor-b" },
      } satisfies FetchAgentHistoryOptions,
    ]);
  });

  it("keeps fulfilled host history when another host fails", async () => {
    const failedClient = createFailingClient();
    const healthyClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "healthy-history",
            cwd: "/repo/healthy",
            updatedAt: "2026-04-02T10:00:00.000Z",
          }),
        ],
        hasMore: true,
        nextCursor: "healthy-cursor",
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "failed-host", serverLabel: "Failed", client: failedClient },
        { serverId: "healthy-host", serverLabel: "Healthy", client: healthyClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
    });

    expect(page.agents.map((agent) => `${agent.serverLabel}:${agent.id}`)).toEqual([
      "Healthy:healthy-history",
    ]);
    expect(page.pageInfoByServerId).toEqual({
      "healthy-host": {
        nextCursor: "healthy-cursor",
        prevCursor: null,
        hasMore: true,
      },
    });
  });

  it("throws when every requested host history fetch fails", async () => {
    await expect(
      fetchAgentHistoryBatch({
        hosts: [
          { serverId: "failed-a", serverLabel: "Failed A", client: createFailingClient() },
          { serverId: "failed-b", serverLabel: "Failed B", client: createFailingClient() },
        ] satisfies AgentHistoryHost[],
        cursorByServerId: null,
      }),
    ).rejects.toThrow("No connected hosts could load agent history");
  });
});
