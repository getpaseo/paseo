/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ForgeSearchClient } from "@/git/use-forge-search-query";
import type { ForgeSearchItem, ForgeSearchResponse } from "@getpaseo/protocol/messages";
import { useComposerForgeAutoAttach } from "./forge-auto-attach";

type ForgeSearchPayload = ForgeSearchResponse["payload"];

const remoteUrl = "git@github.com:acme/paseo.git";
const cwd = "/repo";

const pr101: ForgeSearchItem = {
  kind: "change_request",
  number: 101,
  title: "Attach PR",
  url: "https://github.com/acme/paseo/pull/101",
  state: "open",
  body: null,
  labels: [],
  baseRefName: "main",
  headRefName: "feature",
};

const pr202: ForgeSearchItem = {
  ...pr101,
  number: 202,
  title: "Attach second PR",
  url: "https://github.com/acme/paseo/pull/202",
  headRefName: "feature-two",
};

const issue202: ForgeSearchItem = {
  kind: "issue",
  number: 202,
  title: "Attach issue",
  url: "https://github.com/acme/paseo/issues/202",
  state: "open",
  body: null,
  labels: [],
  baseRefName: null,
  headRefName: null,
};

const gitlabMr73: ForgeSearchItem = {
  forge: "gitlab",
  kind: "change_request",
  number: 73,
  title: "Attach MR",
  url: "https://gitlab.com/acme/paseo/-/merge_requests/73",
  state: "opened",
  body: null,
  labels: [],
  projectPath: "acme/paseo",
  baseRefName: "main",
  headRefName: "feature",
};

const giteaIssue27: ForgeSearchItem = {
  forge: "gitea",
  kind: "issue",
  number: 27,
  title: "Attach Gitea issue",
  url: "https://gitea.example.com/acme/paseo/issues/27",
  state: "open",
  body: null,
  labels: [],
};

interface SearchCall {
  cwd: string;
  query: string;
  limit?: number;
}

interface HarnessInput {
  initialAttachments?: UserComposerAttachment[];
  initialCwd?: string;
  initialText?: string;
  onChangeRequestDetected?: () => void;
  onChangeRequestAdded?: (item: ForgeSearchItem) => void;
  remote?: string | null;
}

function githubPayload(items: ForgeSearchItem[], requestId: string): ForgeSearchPayload {
  return {
    items,
    authState: "authenticated",
    error: null,
    requestId,
  };
}

function createSearchClient(items: ForgeSearchItem[]): ForgeSearchClient & { calls: SearchCall[] } {
  const calls: SearchCall[] = [];
  return {
    calls,
    async searchForge(options) {
      calls.push(options);
      return githubPayload(items, `search-${options.query}`);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function useHarness(client: ForgeSearchClient, input: HarnessInput = {}) {
  const [text, setText] = useState(input.initialText ?? "");
  const [searchClient, setSearchClient] = useState(client);
  const [workingDirectory, setWorkingDirectory] = useState(input.initialCwd ?? cwd);
  const [attachments, setAttachments] = useState<UserComposerAttachment[]>(
    input.initialAttachments ?? [],
  );
  const autoAttach = useComposerForgeAutoAttach({
    text,
    remoteUrl: input.remote ?? remoteUrl,
    attachments,
    client: searchClient,
    isConnected: true,
    serverId: "server-1",
    cwd: workingDirectory,
    setAttachments,
    onChangeRequestDetected: input.onChangeRequestDetected,
    onChangeRequestAdded: input.onChangeRequestAdded,
  });

  return {
    text,
    setText,
    setSearchClient,
    setWorkingDirectory,
    attachments,
    setAttachments,
    isResolving: autoAttach.isResolving,
    markForgeAttachmentRemoved: autoAttach.markForgeAttachmentRemoved,
  };
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
  });
}

describe("useComposerForgeAutoAttach", () => {
  it("adds a matching pasted GitHub PR URL as a composer attachment", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101]);
    const onChangeRequestDetected = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestDetected }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText("Please review https://github.com/acme/paseo/pull/101");
    });
    expect(result.current.isResolving).toBe(true);
    expect(onChangeRequestDetected).toHaveBeenCalledTimes(1);
    await flushDebounce();

    expect(result.current.attachments).toEqual([{ kind: "forge_change_request", item: pr101 }]);
    expect(result.current.isResolving).toBe(false);
    expect(client.calls).toEqual([{ cwd, query: "101", limit: 20 }]);
    vi.useRealTimers();
  });

  it("adds a matching pasted GitLab MR URL as a composer attachment", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([gitlabMr73]);
    const onChangeRequestDetected = vi.fn();
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(
      () =>
        useHarness(client, {
          onChangeRequestDetected,
          onChangeRequestAdded,
          remote: "git@gitlab.com:acme/paseo.git",
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.setText("Review https://gitlab.com/acme/paseo/-/merge_requests/73/diffs");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([
      { kind: "forge_change_request", item: gitlabMr73 },
    ]);
    expect(onChangeRequestDetected).toHaveBeenCalledTimes(1);
    expect(onChangeRequestAdded).toHaveBeenCalledWith(gitlabMr73);
    expect(client.calls).toEqual([{ cwd, query: "73", limit: 20 }]);
    vi.useRealTimers();
  });

  it("adds a matching pasted self-hosted Gitea issue URL", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([giteaIssue27]);
    const { result } = renderHook(
      () =>
        useHarness(client, {
          remote: "git@gitea.example.com:acme/paseo.git",
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.setText("See https://gitea.example.com/acme/paseo/issues/27");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([{ kind: "forge_issue", item: giteaIssue27 }]);
    expect(client.calls).toEqual([{ cwd, query: "27", limit: 20 }]);
    vi.useRealTimers();
  });

  it("ignores URLs that do not match the current remote", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101]);
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Other repo https://github.com/other/paseo/pull/101");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([]);
    expect(client.calls).toEqual([]);
    vi.useRealTimers();
  });

  it("does not add a second pill when the ref is already attached", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101]);
    const initialAttachments: UserComposerAttachment[] = [{ kind: "github_pr", item: pr101 }];
    const { result } = renderHook(() => useHarness(client, { initialAttachments }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText("Already here https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual(initialAttachments);
    expect(client.calls).toEqual([]);
    vi.useRealTimers();
  });

  it("does not re-add a GitHub ref removed earlier in the same composer session", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101]);
    const initialAttachments: UserComposerAttachment[] = [{ kind: "github_pr", item: pr101 }];
    const { result } = renderHook(() => useHarness(client, { initialAttachments }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markForgeAttachmentRemoved(initialAttachments[0]);
      result.current.setAttachments([]);
      result.current.setText("Re-pasted https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([]);
    expect(client.calls).toEqual([]);
    vi.useRealTimers();
  });

  it("handles multiple matching URLs from one paste", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101, issue202]);
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/issues/202",
      );
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([
      { kind: "forge_change_request", item: pr101 },
      { kind: "forge_issue", item: issue202 },
    ]);
    expect(client.calls).toEqual([
      { cwd, query: "101", limit: 20 },
      { cwd, query: "202", limit: 20 },
    ]);
    vi.useRealTimers();
  });

  it("reports pasted pull requests in source order when lookups finish out of order", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    await flushDebounce();

    await act(async () => {
      secondLookup.resolve(githubPayload([pr202], "search-202"));
      await Promise.resolve();
    });
    expect(onChangeRequestAdded).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);

    await act(async () => {
      firstLookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr101], [pr202]]);
      expect(result.current.attachments).toEqual([
        { kind: "forge_change_request", item: pr101 },
        { kind: "forge_change_request", item: pr202 },
      ]);
    });
    vi.useRealTimers();
  });

  it("preserves pull request order across lookup batches", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();
    act(() => {
      result.current.setText(
        "Review https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    expect(result.current.isResolving).toBe(true);
    await flushDebounce();

    await act(async () => {
      secondLookup.resolve(githubPayload([pr202], "search-202"));
      await Promise.resolve();
    });
    expect(onChangeRequestAdded).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isResolving).toBe(true);

    await act(async () => {
      firstLookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr101], [pr202]]);
      expect(result.current.attachments).toEqual([
        { kind: "forge_change_request", item: pr101 },
        { kind: "forge_change_request", item: pr202 },
      ]);
      expect(result.current.isResolving).toBe(false);
    });
    expect(client.searchForge).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses the latest pull request order when URLs are reordered during debounce", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101, pr202]);
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/202 and https://github.com/acme/paseo/pull/101",
      );
    });
    await flushDebounce();

    expect(onChangeRequestAdded.mock.calls).toEqual([[pr202], [pr101]]);
    expect(client.calls).toEqual([
      { cwd, query: "202", limit: 20 },
      { cwd, query: "101", limit: 20 },
    ]);
    vi.useRealTimers();
  });

  it("uses the latest pull request order when active lookups are reordered", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    await flushDebounce();
    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/202 and https://github.com/acme/paseo/pull/101",
      );
    });
    await flushDebounce();

    await act(async () => {
      firstLookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });
    expect(onChangeRequestAdded).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isResolving).toBe(true);

    await act(async () => {
      secondLookup.resolve(githubPayload([pr202], "search-202"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr202], [pr101]]);
      expect(result.current.attachments).toEqual([
        { kind: "forge_change_request", item: pr202 },
        { kind: "forge_change_request", item: pr101 },
      ]);
      expect(result.current.isResolving).toBe(false);
    });
    expect(client.searchForge).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not report a buffered pull request after its URL is removed", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    await flushDebounce();

    await act(async () => {
      secondLookup.resolve(githubPayload([pr202], "search-202"));
      await Promise.resolve();
    });
    act(() => {
      result.current.setText("Still https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    await act(async () => {
      firstLookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr101]]);
    });
    vi.useRealTimers();
  });

  it("keeps resolving when a pending pull request URL is removed and re-added", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi.fn().mockReturnValue(lookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    act(() => {
      result.current.setText("");
    });
    expect(result.current.isResolving).toBe(false);

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    expect(result.current.isResolving).toBe(true);
    await flushDebounce();
    expect(client.searchForge).toHaveBeenCalledTimes(1);

    await act(async () => {
      lookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(result.current.attachments).toEqual([{ kind: "forge_change_request", item: pr101 }]);
      expect(result.current.isResolving).toBe(false);
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr101]]);
    });
    vi.useRealTimers();
  });

  it("releases a removed ref without waiting for its lookup to settle", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const onChangeRequestAdded = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onChangeRequestAdded }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    await flushDebounce();

    await act(async () => {
      secondLookup.resolve(githubPayload([pr202], "search-202"));
      await Promise.resolve();
    });
    expect(onChangeRequestAdded).not.toHaveBeenCalled();
    expect(result.current.isResolving).toBe(true);

    act(() => {
      result.current.setText("Still https://github.com/acme/paseo/pull/202");
    });
    await flushDebounce();

    await vi.waitFor(() => {
      expect(onChangeRequestAdded.mock.calls).toEqual([[pr202]]);
      expect(result.current.isResolving).toBe(false);
    });

    await act(async () => {
      firstLookup.resolve(githubPayload([], "search-101"));
      await Promise.resolve();
    });
    vi.useRealTimers();
  });

  it("stays resolving when an unrelated attachment is added during lookup", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi.fn().mockReturnValue(lookup.promise),
    };
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    act(() => {
      result.current.setAttachments([{ kind: "forge_issue", item: issue202 }]);
      result.current.setText("Review https://github.com/acme/paseo/pull/101 please");
    });

    expect(result.current.isResolving).toBe(true);

    await act(async () => {
      lookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });

    expect(result.current.attachments).toEqual([
      { kind: "forge_issue", item: issue202 },
      { kind: "forge_change_request", item: pr101 },
    ]);
    expect(result.current.isResolving).toBe(false);
    vi.useRealTimers();
  });

  it("stops resolving when an in-flight PR URL is removed", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi.fn().mockReturnValue(lookup.promise),
    };
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();
    act(() => {
      result.current.setText("");
    });

    expect(result.current.isResolving).toBe(false);
    vi.useRealTimers();
  });

  it("ignores a lookup that finishes after the target changes", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi.fn().mockReturnValue(lookup.promise),
    };
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    act(() => {
      result.current.setWorkingDirectory("/other-repo");
    });
    await flushDebounce();
    await act(async () => {
      lookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });

    expect(result.current.attachments).toEqual([]);
    expect(client.searchForge).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("accepts a lookup after the transport client is replaced for the same target", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ForgeSearchPayload>();
    const firstClient: ForgeSearchClient = {
      searchForge: vi.fn().mockReturnValue(lookup.promise),
    };
    const replacementClient = createSearchClient([pr101]);
    const { result } = renderHook(() => useHarness(firstClient), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();
    act(() => {
      result.current.setSearchClient(replacementClient);
    });
    await act(async () => {
      lookup.resolve(githubPayload([pr101], "search-101"));
      await Promise.resolve();
    });

    expect(result.current.attachments).toEqual([{ kind: "forge_change_request", item: pr101 }]);
    expect(replacementClient.calls).toEqual([]);
    vi.useRealTimers();
  });
});
