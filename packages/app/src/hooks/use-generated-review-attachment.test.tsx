import "@/test/window-local-storage";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutStatusResponse } from "@server/shared/messages";
import type { ParsedDiffFile } from "@/hooks/use-checkout-diff-query";
import {
  buildReviewDraftKey,
  buildReviewDraftScopeKey,
  useReviewDraftStore,
} from "@/stores/review-draft-store";
import {
  useGeneratedReviewAttachment,
  type UseGeneratedReviewAttachmentResult,
} from "./use-generated-review-attachment";

type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    getCheckoutStatus: vi.fn(),
    subscribeCheckoutDiff: vi.fn(),
    unsubscribeCheckoutDiff: vi.fn(),
    on: vi.fn(() => () => {}),
  };
  return { mockClient };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-changes-preferences", () => ({
  useChangesPreferences: () => ({
    preferences: { hideWhitespace: false },
  }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

const serverId = "server";
const cwd = "/repo";

function checkoutStatus(): CheckoutStatusPayload {
  return {
    cwd,
    error: null,
    requestId: "checkout-status-1",
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: cwd,
    currentBranch: "main",
    isDirty: false,
    baseRef: "origin/main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "git@github.com:getpaseo/paseo.git",
  } as CheckoutStatusPayload;
}

function makeFile(): ParsedDiffFile {
  return {
    path: "src/example.ts",
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 1,
    status: "ok",
    hunks: [
      {
        oldStart: 40,
        oldCount: 2,
        newStart: 40,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -40,2 +40,2 @@" },
          { type: "context", content: "const before = true;" },
          { type: "add", content: "const value = newValue;" },
        ],
      },
    ],
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushAsyncWork();
    }
  }
  throw lastError;
}

describe("useGeneratedReviewAttachment", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient | null = null;
  let latest: UseGeneratedReviewAttachmentResult | null = null;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost",
    });
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("navigator", dom.window.navigator);

    container = document.getElementById("root");
    root = createRoot(container!);
    queryClient = createQueryClient();
    latest = null;
    mockClient.getCheckoutStatus.mockReset();
    mockClient.subscribeCheckoutDiff.mockReset();
    mockClient.unsubscribeCheckoutDiff.mockReset();
    mockClient.on.mockClear();
    useReviewDraftStore.setState({ drafts: {}, activeModesByScope: {} });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    queryClient?.clear();
    root = null;
    container = null;
    queryClient = null;
    vi.unstubAllGlobals();
  });

  it("fetches a review-specific diff snapshot when the diff cache is cold", async () => {
    const reviewDraftKey = buildReviewDraftKey({
      serverId,
      workspaceId: "workspace-1",
      cwd,
      mode: "base",
      baseRef: "origin/main",
      ignoreWhitespace: false,
    });
    useReviewDraftStore.getState().addComment({
      key: reviewDraftKey,
      comment: {
        id: "comment-1",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Please simplify this.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    });
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus());
    mockClient.subscribeCheckoutDiff.mockResolvedValue({
      cwd,
      requestId: "diff-1",
      files: [makeFile()],
      error: null,
    });

    function Probe() {
      latest = useGeneratedReviewAttachment({
        serverId,
        workspaceId: "workspace-1",
        cwd,
      });
      return null;
    }

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient!}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await waitForExpectation(() => {
      expect(mockClient.subscribeCheckoutDiff).toHaveBeenCalledWith(
        cwd,
        {
          mode: "base",
          baseRef: "origin/main",
          ignoreWhitespace: false,
        },
        expect.objectContaining({ subscriptionId: expect.stringContaining("checkoutDiff") }),
      );
      expect(latest?.attachment?.attachment.comments).toHaveLength(1);
    });
  });

  it("uses the active changes diff mode instead of dirty-worktree auto mode", async () => {
    const reviewDraftScopeKey = buildReviewDraftScopeKey({
      serverId,
      workspaceId: "workspace-1",
      cwd,
      baseRef: "origin/main",
      ignoreWhitespace: false,
    });
    const reviewDraftKey = buildReviewDraftKey({
      serverId,
      workspaceId: "workspace-1",
      cwd,
      mode: "base",
      baseRef: "origin/main",
      ignoreWhitespace: false,
    });
    useReviewDraftStore.getState().setActiveMode({
      scopeKey: reviewDraftScopeKey,
      mode: "base",
    });
    useReviewDraftStore.getState().addComment({
      key: reviewDraftKey,
      comment: {
        id: "comment-1",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Review the committed diff.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    });
    mockClient.getCheckoutStatus.mockResolvedValue({
      ...checkoutStatus(),
      isDirty: true,
    });
    mockClient.subscribeCheckoutDiff.mockResolvedValue({
      cwd,
      requestId: "diff-1",
      files: [makeFile()],
      error: null,
    });

    function Probe() {
      latest = useGeneratedReviewAttachment({
        serverId,
        workspaceId: "workspace-1",
        cwd,
      });
      return null;
    }

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient!}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await waitForExpectation(() => {
      expect(mockClient.subscribeCheckoutDiff).toHaveBeenCalledWith(
        cwd,
        {
          mode: "base",
          baseRef: "origin/main",
          ignoreWhitespace: false,
        },
        expect.objectContaining({ subscriptionId: expect.stringContaining("checkoutDiff") }),
      );
      expect(latest?.attachment?.attachment.mode).toBe("base");
      expect(latest?.attachment?.attachment.comments[0]?.body).toBe("Review the committed diff.");
    });
  });

  it("uses dirty-worktree auto mode when no active review mode is set", async () => {
    const baseReviewDraftKey = buildReviewDraftKey({
      serverId,
      workspaceId: "workspace-1",
      cwd,
      mode: "base",
      baseRef: "origin/main",
      ignoreWhitespace: false,
    });
    const uncommittedReviewDraftKey = buildReviewDraftKey({
      serverId,
      workspaceId: "workspace-1",
      cwd,
      mode: "uncommitted",
      baseRef: "origin/main",
      ignoreWhitespace: false,
    });
    useReviewDraftStore.getState().addComment({
      key: baseReviewDraftKey,
      comment: {
        id: "comment-base",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Review the committed diff.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    });
    useReviewDraftStore.getState().addComment({
      key: uncommittedReviewDraftKey,
      comment: {
        id: "comment-uncommitted",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Review the dirty diff.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    });
    mockClient.getCheckoutStatus.mockResolvedValue({
      ...checkoutStatus(),
      isDirty: true,
    });
    mockClient.subscribeCheckoutDiff.mockResolvedValue({
      cwd,
      requestId: "diff-1",
      files: [makeFile()],
      error: null,
    });

    function Probe() {
      latest = useGeneratedReviewAttachment({
        serverId,
        workspaceId: "workspace-1",
        cwd,
      });
      return null;
    }

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient!}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await waitForExpectation(() => {
      expect(mockClient.subscribeCheckoutDiff).toHaveBeenCalledWith(
        cwd,
        {
          mode: "uncommitted",
          baseRef: undefined,
          ignoreWhitespace: false,
        },
        expect.objectContaining({ subscriptionId: expect.stringContaining("checkoutDiff") }),
      );
      expect(latest?.attachment?.attachment.mode).toBe("uncommitted");
      expect(latest?.attachment?.attachment.comments[0]?.body).toBe("Review the dirty diff.");
    });
  });
});
