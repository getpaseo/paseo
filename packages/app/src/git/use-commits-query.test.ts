/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useCheckoutCommitsQuery } from "./use-commits-query";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const hostRuntime = vi.hoisted(() => ({
  listCheckoutCommits: vi.fn(),
  isConnected: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listCheckoutCommits: hostRuntime.listCheckoutCommits }),
  useHostRuntimeIsConnected: () => hostRuntime.isConnected,
}));

const serverId = "server-1";
const cwd = "/tmp/repo";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderCommitsHook<TResult>(callback: () => TResult) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(callback, { wrapper });
}

function setCommitsListCapability(present: boolean) {
  useSessionStore.setState((state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [serverId]: {
        serverInfo: { features: present ? { commitsList: true } : {} },
      } as unknown as (typeof state.sessions)[string],
    },
  }));
}

describe("useCheckoutCommitsQuery", () => {
  beforeEach(() => {
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("reports capabilityMissing and never fetches when the daemon lacks commitsList", async () => {
    setCommitsListCapability(false);

    const { result } = renderCommitsHook(() => useCheckoutCommitsQuery({ serverId, cwd }));

    await waitFor(() => {
      expect(result.current.capabilityMissing).toBe(true);
    });

    expect(hostRuntime.listCheckoutCommits).not.toHaveBeenCalled();
    expect(result.current.commits).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches and returns commits when the daemon advertises commitsList", async () => {
    const commits: CheckoutCommit[] = [
      {
        sha: "abc123def456",
        shortSha: "abc123d",
        subject: "Add feature",
        authorName: "Ada",
        authorDate: "2026-06-13T00:00:00.000Z",
        isOnRemote: false,
        files: [{ path: "src/index.ts", additions: 10, deletions: 2 }],
      },
    ];
    hostRuntime.listCheckoutCommits.mockResolvedValue({ baseRef: "main", commits });
    setCommitsListCapability(true);

    const { result } = renderCommitsHook(() => useCheckoutCommitsQuery({ serverId, cwd }));

    await waitFor(() => {
      expect(result.current.commits).toEqual(commits);
    });

    expect(hostRuntime.listCheckoutCommits).toHaveBeenCalledWith(cwd);
    expect(result.current.capabilityMissing).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
