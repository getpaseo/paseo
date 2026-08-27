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
let collectAgentHistoryHostErrors: UseAgentHistoryModule["collectAgentHistoryHostErrors"];

beforeAll(async () => {
  const module = await import("./use-agent-history");
  fetchAgentHistoryBatch = module.fetchAgentHistoryBatch;
  fetchAgentHistoryPage = module.fetchAgentHistoryPage;
  collectAgentHistoryHostErrors = module.collectAgentHistoryHostErrors;
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
  searchTruncated?: boolean;
}): FetchAgentHistoryResult {
  return {
    requestId: "req_history",
    entries: input.entries,
    pageInfo: {
      nextCursor: input.nextCursor ?? null,
      prevCursor: null,
      hasMore: input.hasMore ?? false,
    },
    ...(input.searchTruncated === undefined ? {} : { searchTruncated: input.searchTruncated }),
  };
}

function historyEntry(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  title?: string | null;
  archivedAt?: string | null;
  searchScore?: number;
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
    ...(input.searchScore === undefined ? {} : { searchScore: input.searchScore }),
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

  it("sends the query to the daemon rather than filtering the page locally", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "match",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Add Stripe billing",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({
      client,
      serverId: "server-1",
      cursor: null,
      search: "stripe",
    });

    expect(client.calls[0]?.search).toBe("stripe");
    expect(page.searchScoreByAgentKey).toEqual({ "server-1:match": 1000 });
  });

  it("keeps per-host scores apart when two hosts issue the same agent id", async () => {
    const sharedId = "collision";
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: sharedId,
            cwd: "/repo/a",
            updatedAt: "2026-04-09T10:00:00.000Z",
            title: "Weak match on A",
            searchScore: 4000,
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: sharedId,
            cwd: "/repo/b",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Strong match on B",
            searchScore: 1000,
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
      search: "match",
    });

    expect(page.searchScoreByAgentKey).toEqual({
      "server-a:collision": 4000,
      "server-b:collision": 1000,
    });
    expect(page.agents.map((agent) => agent.title)).toEqual([
      "Strong match on B",
      "Weak match on A",
    ]);
  });

  it("reports truncation when a host had more matches than its page could hold", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "top",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Top match",
            searchScore: 1000,
          }),
        ],
        searchTruncated: true,
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.isSearchTruncated).toBe(true);
    // A ranked response promises no next page, so nothing can ask for one.
    expect(page.pageInfoByServerId["server-a"]).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
  });

  it("reports truncation when two complete host pages overflow the merge", async () => {
    // Neither host is locally truncated; together they exceed what the merged
    // list can show, and the footer has to say so.
    const buildHost = (serverId: string, count: number) =>
      createClient([
        historyPayload({
          entries: Array.from({ length: count }, (_, index) =>
            historyEntry({
              id: `${serverId}-${index}`,
              cwd: `/repo/${serverId}`,
              updatedAt: "2026-04-01T10:00:00.000Z",
              title: `Match ${index}`,
              searchScore: 1000 + index,
            }),
          ),
        }),
      ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: buildHost("server-a", 150) },
        { serverId: "server-b", serverLabel: "Linux box", client: buildHost("server-b", 150) },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.isSearchTruncated).toBe(true);
    expect(page.agents).toHaveLength(200);
  });

  it("names the host that failed instead of quietly shortening the list", async () => {
    const workingClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "reachable",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Reachable match",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: workingClient },
        { serverId: "server-b", serverLabel: "Linux box", client: createFailingClient() },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.hostErrors).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
    expect(page.agents.map((agent) => agent.id)).toEqual(["reachable"]);
  });

  it("keeps naming a host that failed page one when another host loads page two", async () => {
    // A host that rejects the first page contributes no cursor, so it is never
    // asked again. Reading only the newest page would drop its error while its
    // history stays missing, so the projection has to see every page.
    const workingClient = createClient([
      historyPayload({
        entries: [
          historyEntry({ id: "page-1", cwd: "/repo/a", updatedAt: "2026-04-02T10:00:00.000Z" }),
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
      historyPayload({
        entries: [
          historyEntry({ id: "page-2", cwd: "/repo/a", updatedAt: "2026-04-01T10:00:00.000Z" }),
        ],
      }),
    ]);
    const hosts = [
      { serverId: "server-a", serverLabel: "MacBook", client: workingClient },
      { serverId: "server-b", serverLabel: "Linux box", client: createFailingClient() },
    ] satisfies AgentHistoryHost[];

    const firstPage = await fetchAgentHistoryBatch({ hosts, cursorByServerId: null });
    const secondPage = await fetchAgentHistoryBatch({
      hosts,
      cursorByServerId: { "server-a": "cursor-2" },
    });

    // Only the healthy host is re-fetched, so the second page carries no error
    // of its own. That is exactly why the screen cannot read the newest page.
    expect(secondPage.hostErrors).toEqual([]);
    expect(secondPage.agents.map((agent) => agent.id)).toEqual(["page-2"]);
    expect(
      collectAgentHistoryHostErrors({
        pages: [firstPage, secondPage],
        unreachableHosts: [],
      }),
    ).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
  });

  it("reports a host that is not connected alongside one whose request failed", () => {
    expect(
      collectAgentHistoryHostErrors({
        pages: [{ hostErrors: [{ serverId: "server-b", serverName: "Linux box" }] }],
        unreachableHosts: [{ serverId: "server-c", serverName: "Offline box" }],
      }),
    ).toEqual([
      { serverId: "server-c", serverName: "Offline box" },
      { serverId: "server-b", serverName: "Linux box" },
    ]);
  });

  it("names a host once when it is both unreachable and failed", () => {
    expect(
      collectAgentHistoryHostErrors({
        pages: [{ hostErrors: [{ serverId: "server-b", serverName: "Linux box" }] }],
        unreachableHosts: [{ serverId: "server-b", serverName: "Linux box" }],
      }),
    ).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
  });
  it("orders a searched all-host page by relevance instead of recency", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "newer-weak-match",
            cwd: "/repo/a",
            updatedAt: "2026-04-09T10:00:00.000Z",
            title: "Unbilled usage report",
            searchScore: 4000,
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "older-strong-match",
            cwd: "/repo/b",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Bill the customer",
            searchScore: 1000,
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
      search: "bill",
    });

    expect(page.agents.map((agent) => agent.id)).toEqual([
      "older-strong-match",
      "newer-weak-match",
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
