/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useCommitFileDiff } from "./use-commit-file-diff";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const hostRuntime = vi.hoisted(() => ({
  getCommitFileDiff: vi.fn(),
  isConnected: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ getCommitFileDiff: hostRuntime.getCommitFileDiff }),
  useHostRuntimeIsConnected: () => hostRuntime.isConnected,
}));

const serverId = "server-1";
const cwd = "/tmp/repo";
const sha = "abc123def456";
const path = "src/index.ts";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDiffHook<TResult>(callback: () => TResult) {
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

function makeFile(): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 1,
    status: "ok",
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "context", content: " const a = 1;" },
          { type: "add", content: "+const b = 2;" },
        ],
      },
    ],
  };
}

describe("useCommitFileDiff", () => {
  beforeEach(() => {
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("does not fetch when disabled (no file selected)", async () => {
    setCommitsListCapability(true);

    const { result } = renderDiffHook(() =>
      useCommitFileDiff({ serverId, cwd, sha, path, enabled: false }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(hostRuntime.getCommitFileDiff).not.toHaveBeenCalled();
    expect(result.current.file).toBeNull();
  });

  it("does not fetch when the capability is missing", async () => {
    setCommitsListCapability(false);

    const { result } = renderDiffHook(() =>
      useCommitFileDiff({ serverId, cwd, sha, path, enabled: true }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(hostRuntime.getCommitFileDiff).not.toHaveBeenCalled();
    expect(result.current.file).toBeNull();
  });

  it("fetches and returns the file when enabled and capability present", async () => {
    const file = makeFile();
    hostRuntime.getCommitFileDiff.mockResolvedValue({ file });
    setCommitsListCapability(true);

    const { result } = renderDiffHook(() =>
      useCommitFileDiff({ serverId, cwd, sha, path, enabled: true }),
    );

    await waitFor(() => {
      expect(result.current.file).toEqual(file);
    });

    expect(hostRuntime.getCommitFileDiff).toHaveBeenCalledWith(cwd, sha, path);
    expect(result.current.error).toBeNull();
  });

  it("surfaces errors from the client", async () => {
    hostRuntime.getCommitFileDiff.mockRejectedValue(new Error("boom"));
    setCommitsListCapability(true);

    const { result } = renderDiffHook(() =>
      useCommitFileDiff({ serverId, cwd, sha, path, enabled: true }),
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.file).toBeNull();
  });
});
