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
  initialText?: string;
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
  const [attachments, setAttachments] = useState<UserComposerAttachment[]>(
    input.initialAttachments ?? [],
  );
  const autoAttach = useComposerGithubAutoAttach({
    text,
    remoteUrl: input.remote ?? remoteUrl,
    attachments,
    client,
    isConnected: true,
    serverId: "server-1",
    cwd,
    setAttachments,
  });

  return {
    text,
    setText,
    attachments,
    setAttachments,
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
    const { result } = renderHook(() => useHarness(client), { wrapper: createWrapper() });

    act(() => {
      result.current.setText("Please review https://github.com/acme/paseo/pull/101");
    });
    await flushDebounce();

    expect(result.current.attachments).toEqual([{ kind: "forge_change_request", item: pr101 }]);
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
});
