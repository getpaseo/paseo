/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutCommit, ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { DiffTarget } from "@/git/diff-target";
import { useSessionStore } from "@/stores/session-store";
import { useDiffFiles } from "./use-diff-files";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const hostRuntime = vi.hoisted(() => ({
  getCommitFileDiff: vi.fn(),
  listCheckoutCommits: vi.fn(),
  isConnected: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    getCommitFileDiff: hostRuntime.getCommitFileDiff,
    listCheckoutCommits: hostRuntime.listCheckoutCommits,
  }),
  useHostRuntimeIsConnected: () => hostRuntime.isConnected,
}));

// The working target delegates to useCheckoutDiffQuery; mock it so the test
// exercises the unification logic, not the subscription plumbing.
const checkoutDiffMock = vi.hoisted(() => ({
  files: [] as ParsedDiffFile[],
  isLoading: false,
  error: null as Error | null,
  spy: vi.fn(),
}));

vi.mock("./use-diff-query", () => ({
  useCheckoutDiffQuery: (options: unknown) => {
    checkoutDiffMock.spy(options);
    return {
      files: checkoutDiffMock.files,
      payloadError: checkoutDiffMock.error,
      isLoading: checkoutDiffMock.isLoading,
      isFetching: false,
      isError: Boolean(checkoutDiffMock.error),
      error: checkoutDiffMock.error,
    };
  },
}));

const serverId = "server-1";
const workspaceId = "workspace-1";
const cwd = "/tmp/repo";
const sha = "abc123def456";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDiffFilesHook<TResult>(callback: () => TResult) {
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

function makeFile(path: string): ParsedDiffFile {
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

function paths(files: ParsedDiffFile[]): string[] {
  return files.map((file) => file.path);
}

function makeCommit(commitPaths: string[]): CheckoutCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: "Add feature",
    authorName: "Ada",
    authorDate: "2026-06-13T00:00:00.000Z",
    isOnRemote: false,
    files: commitPaths.map((path) => ({ path, additions: 1, deletions: 0 })),
  };
}

const workingTarget: DiffTarget = { kind: "working", mode: "uncommitted" };
const commitTarget: DiffTarget = { kind: "commit", sha };

// Mutable target reference for the hook-order stability test.
let currentTarget: DiffTarget = workingTarget;

describe("useDiffFiles", () => {
  beforeEach(() => {
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
    checkoutDiffMock.files = [];
    checkoutDiffMock.isLoading = false;
    checkoutDiffMock.error = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("returns the working query files/loading/error for a working target", async () => {
    const files = [makeFile("a.ts"), makeFile("b.ts")];
    checkoutDiffMock.files = files;

    const { result } = renderDiffFilesHook(() =>
      useDiffFiles(workingTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(result.current.files).toEqual(files);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.capabilityMissing).toBeUndefined();
    // The working target drives the checkout diff query; the commit fan-out stays idle.
    expect(hostRuntime.getCommitFileDiff).not.toHaveBeenCalled();
    expect(checkoutDiffMock.spy).toHaveBeenCalledWith(
      expect.objectContaining({ serverId, cwd, mode: "uncommitted", enabled: true }),
    );
  });

  it("surfaces the working query loading + error for a working target", async () => {
    checkoutDiffMock.isLoading = true;
    checkoutDiffMock.error = new Error("working boom");

    const { result } = renderDiffFilesHook(() =>
      useDiffFiles(workingTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe("working boom");
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.files).toEqual([]);
  });

  it("finds the commit, fetches each file in order and skips nulls for a commit target", async () => {
    const commit = makeCommit(["a.ts", "binary.png", "c.ts"]);
    hostRuntime.listCheckoutCommits.mockResolvedValue({ baseRef: "main", commits: [commit] });
    const fileA = makeFile("a.ts");
    const fileC = makeFile("c.ts");
    hostRuntime.getCommitFileDiff.mockImplementation(
      async (_cwd: string, _sha: string, path: string) => {
        if (path === "a.ts") return { file: fileA };
        if (path === "c.ts") return { file: fileC };
        return { file: null }; // binary/empty
      },
    );
    setCommitsListCapability(true);

    const { result } = renderDiffFilesHook(() =>
      useDiffFiles(commitTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(result.current.files).toEqual([fileA, fileC]);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.capabilityMissing).toBe(false);
    expect(hostRuntime.getCommitFileDiff).toHaveBeenCalledWith(cwd, sha, "a.ts");
    expect(hostRuntime.getCommitFileDiff).toHaveBeenCalledWith(cwd, sha, "binary.png");
    expect(hostRuntime.getCommitFileDiff).toHaveBeenCalledWith(cwd, sha, "c.ts");
    // The working diff query stays disabled for a commit target.
    expect(checkoutDiffMock.spy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("aggregates the first file-diff error for a commit target", async () => {
    const commit = makeCommit(["a.ts", "b.ts"]);
    hostRuntime.listCheckoutCommits.mockResolvedValue({ baseRef: "main", commits: [commit] });
    hostRuntime.getCommitFileDiff.mockImplementation(
      async (_cwd: string, _sha: string, path: string) => {
        if (path === "a.ts") throw new Error("file boom");
        return { file: makeFile("b.ts") };
      },
    );
    setCommitsListCapability(true);

    const { result } = renderDiffFilesHook(() =>
      useDiffFiles(commitTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe("file boom");
    });
  });

  it("surfaces capabilityMissing and never fetches when the commits capability is absent", async () => {
    setCommitsListCapability(false);

    const { result } = renderDiffFilesHook(() =>
      useDiffFiles(commitTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(result.current.capabilityMissing).toBe(true);
    });

    expect(hostRuntime.listCheckoutCommits).not.toHaveBeenCalled();
    expect(hostRuntime.getCommitFileDiff).not.toHaveBeenCalled();
    expect(result.current.files).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps hook order stable across a target.kind change", async () => {
    currentTarget = workingTarget;
    const commit = makeCommit(["a.ts"]);
    hostRuntime.listCheckoutCommits.mockResolvedValue({ baseRef: "main", commits: [commit] });
    hostRuntime.getCommitFileDiff.mockResolvedValue({ file: makeFile("a.ts") });
    checkoutDiffMock.files = [makeFile("working.ts")];
    setCommitsListCapability(true);

    const { result, rerender } = renderDiffFilesHook(() =>
      useDiffFiles(currentTarget, { serverId, workspaceId, cwd }),
    );

    await waitFor(() => {
      expect(paths(result.current.files)).toEqual(["working.ts"]);
    });

    // Switching the target kind must not throw "rendered more/fewer hooks".
    currentTarget = commitTarget;
    rerender();

    await waitFor(() => {
      expect(paths(result.current.files)).toEqual(["a.ts"]);
    });
  });
});
