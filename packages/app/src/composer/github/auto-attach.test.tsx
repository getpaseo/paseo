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
import { useComposerGithubAutoAttach } from "./auto-attach";

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

interface SearchCall {
  cwd: string;
  query: string;
  limit?: number;
}

interface HarnessInput {
  initialAttachments?: UserComposerAttachment[];
  initialCwd?: string;
  initialText?: string;
  onPullRequestDetected?: () => void;
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
  const autoAttach = useComposerGithubAutoAttach({
    text,
    remoteUrl: input.remote ?? remoteUrl,
    attachments,
    client: searchClient,
    isConnected: true,
    serverId: "server-1",
    cwd: workingDirectory,
    setAttachments,
    onPullRequestDetected: input.onPullRequestDetected,
  });

  return {
    text,
    setText,
    setSearchClient,
    setWorkingDirectory,
    attachments,
    setAttachments,
    isResolving: autoAttach.isResolving,
    markGithubAttachmentRemoved: autoAttach.markGithubAttachmentRemoved,
  };
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
  });
}

describe("useComposerGithubAutoAttach", () => {
  it("adds a matching pasted GitHub PR URL as a composer attachment", async () => {
    vi.useFakeTimers();
    const client = createSearchClient([pr101]);
    const onPullRequestDetected = vi.fn();
    const { result } = renderHook(() => useHarness(client, { onPullRequestDetected }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setText("Please review https://github.com/acme/paseo/pull/101");
    });
    expect(result.current.isResolving).toBe(true);
    expect(onPullRequestDetected).toHaveBeenCalledTimes(1);
    await flushDebounce();

    expect(result.current.attachments).toEqual([{ kind: "forge_change_request", item: pr101 }]);
    expect(result.current.isResolving).toBe(false);
    expect(client.calls).toEqual([{ cwd, query: "101", limit: 20 }]);
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
      result.current.markGithubAttachmentRemoved(initialAttachments[0]);
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

  it("stays resolving while overlapping lookups share a ref", async () => {
    vi.useFakeTimers();
    const firstLookup = deferred<ForgeSearchPayload>();
    const secondLookup = deferred<ForgeSearchPayload>();
    const client: ForgeSearchClient = {
      searchForge: vi
        .fn()
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise),
    };
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText(
        "Refs https://github.com/acme/paseo/pull/101 and https://github.com/acme/paseo/pull/202",
      );
    });
    await flushDebounce();

    act(() => {
      result.current.setText("Still https://github.com/acme/paseo/pull/202");
    });
    await flushDebounce();

    await act(async () => {
      firstLookup.resolve(githubPayload([], "search-101"));
      await Promise.resolve();
    });
    expect(result.current.isResolving).toBe(true);

    await act(async () => {
      secondLookup.resolve(githubPayload([], "search-202"));
      await Promise.resolve();
    });
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
