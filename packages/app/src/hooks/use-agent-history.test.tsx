/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  FetchAgentHistoryEntry,
  FetchAgentHistoryOptions,
} from "@server/client/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useAgentHistory } from "./use-agent-history";

const { mockClient, mockRuntimeStore } = vi.hoisted(() => {
  const hoistedClient = {
    fetchAgentHistory: vi.fn(),
  };
  const hoistedRuntimeStore = {
    refreshAgentDirectory: vi.fn(),
  };
  return { mockClient: hoistedClient, mockRuntimeStore: hoistedRuntimeStore };
});

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => mockRuntimeStore,
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
  useHosts: () => [{ serverId: "server-1", label: "Local" }],
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function renderAgentHistoryHook(options?: { enabled?: boolean }) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useAgentHistory({ serverId: "server-1", enabled: options?.enabled }), {
    wrapper,
  });
}

function makeHistoryPayload(input: {
  entries: FetchAgentHistoryEntry[];
  hasMore?: boolean;
  nextCursor?: string | null;
}): Awaited<ReturnType<DaemonClient["fetchAgentHistory"]>> {
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

function makeHistoryEntry(input: {
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

function makeActiveAgent(): Agent {
  const timestamp = new Date("2026-04-01T10:00:00.000Z");
  return {
    serverId: "server-1",
    id: "active-1",
    provider: "codex",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUserMessageAt: null,
    lastActivityAt: timestamp,
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
    title: "Active",
    cwd: "/repo",
    model: null,
    labels: {},
    archivedAt: null,
    parentAgentId: null,
  };
}

afterEach(() => {
  mockClient.fetchAgentHistory.mockReset();
  mockRuntimeStore.refreshAgentDirectory.mockReset();
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
});

function agentIds(agents: ReadonlyArray<{ id: string }>): string[] {
  return agents.map((agent) => agent.id);
}

describe("useAgentHistory", () => {
  it("loads history one page at a time without refreshing active agents", async () => {
    mockClient.fetchAgentHistory
      .mockResolvedValueOnce(
        makeHistoryPayload({
          entries: [
            makeHistoryEntry({
              id: "history-1",
              cwd: "/repo",
              updatedAt: "2026-04-02T10:00:00.000Z",
              title: "History one",
            }),
          ],
          hasMore: true,
          nextCursor: "cursor-2",
        }),
      )
      .mockResolvedValueOnce(
        makeHistoryPayload({
          entries: [
            makeHistoryEntry({
              id: "history-2",
              cwd: "/repo",
              updatedAt: "2026-04-01T10:00:00.000Z",
              title: "History two",
              archivedAt: "2026-04-01T10:05:00.000Z",
            }),
          ],
        }),
      );

    act(() => {
      useSessionStore
        .getState()
        .initializeSession("server-1", mockClient as unknown as DaemonClient);
      useSessionStore.getState().setAgents("server-1", new Map([["active-1", makeActiveAgent()]]));
    });

    const { result } = renderAgentHistoryHook();

    await waitFor(() => {
      expect(mockClient.fetchAgentHistory).toHaveBeenCalledTimes(1);
    });

    expect(mockClient.fetchAgentHistory.mock.calls.map(([options]) => options)).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200 },
      },
    ] satisfies FetchAgentHistoryOptions[]);
    await waitFor(() => {
      expect(agentIds(result.current.agents)).toEqual(["history-1"]);
    });
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(mockClient.fetchAgentHistory).toHaveBeenCalledTimes(2);
    });

    expect(mockClient.fetchAgentHistory.mock.calls.at(-1)?.[0]).toEqual({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "cursor-2" },
    } satisfies FetchAgentHistoryOptions);
    await waitFor(() => {
      expect(agentIds(result.current.agents)).toEqual(["history-1", "history-2"]);
    });
    expect(result.current.hasMore).toBe(false);
    expect(
      Array.from(useSessionStore.getState().sessions["server-1"]?.agents.keys() ?? []),
    ).toEqual(["active-1"]);
    expect(mockRuntimeStore.refreshAgentDirectory).not.toHaveBeenCalled();
  });

  it("waits until history is enabled before calling the history RPC", async () => {
    mockClient.fetchAgentHistory.mockResolvedValue(makeHistoryPayload({ entries: [] }));

    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    let enabled = false;
    const { rerender } = renderHook(() => useAgentHistory({ serverId: "server-1", enabled }), {
      wrapper,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockClient.fetchAgentHistory).not.toHaveBeenCalled();

    enabled = true;
    rerender();

    await waitFor(() => {
      expect(mockClient.fetchAgentHistory).toHaveBeenCalledTimes(1);
    });
  });
});
