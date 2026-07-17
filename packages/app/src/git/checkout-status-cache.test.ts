// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import { checkoutPrStatusQueryKey, checkoutStatusQueryKey } from "@/git/query-keys";
import {
  prPanePipelineQueryKey,
  prPaneTimelineQueryKey,
} from "@/git/pull-request-panel/query-keys";
import { resetReviewDraftStore, useReviewDraftStore } from "@/review/store";
import {
  applyCheckoutStatusUpdateFromEvent,
  type CheckoutPrStatusPayload,
  type CheckoutStatusPayload,
  fetchCheckoutStatus,
} from "./checkout-status-cache";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const serverId = "server-1";
const cwd = "/repo";

function checkoutStatus(overrides: Partial<CheckoutStatusPayload> = {}): CheckoutStatusPayload {
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
    ...overrides,
  } as CheckoutStatusPayload;
}

function prStatus(overrides: Partial<CheckoutPrStatusPayload> = {}): CheckoutPrStatusPayload {
  return {
    cwd,
    status: {
      forge: "github",
      url: "https://github.com/getpaseo/paseo/pull/42",
      title: "My PR",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      isDraft: false,
      mergeable: "MERGEABLE",
      checks: [],
      checksStatus: "success",
      reviewDecision: null,
    },
    githubFeaturesEnabled: true,
    authState: "authenticated",
    forge: "github",
    error: null,
    requestId: "pr-status-1",
    ...overrides,
  };
}

function checkoutStatusUpdate(
  payload: CheckoutStatusPayload,
  extraPrStatus?: NonNullable<CheckoutStatusUpdate["payload"]["prStatus"]>,
): CheckoutStatusUpdate {
  return {
    type: "checkout_status_update",
    payload: extraPrStatus ? { ...payload, prStatus: extraPrStatus } : payload,
  };
}

function setDiffModeOverride(isDirtyAtSelection: boolean): void {
  useReviewDraftStore.getState().setDiffModeOverride({
    scopeKey: "review:scope",
    override: { serverId, cwd, mode: "base", isDirtyAtSelection },
  });
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  resetReviewDraftStore();
});

describe("fetchCheckoutStatus", () => {
  it("fetches from the client and returns the payload", async () => {
    const fetched = checkoutStatus({ requestId: "fetch-1" });
    const client = { getCheckoutStatus: vi.fn(async () => fetched) };

    const result = await fetchCheckoutStatus({ client, serverId, cwd });

    expect(result).toEqual(fetched);
    expect(client.getCheckoutStatus).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it("expires a manual diff-mode override when the fetched dirty state flipped", async () => {
    setDiffModeOverride(true);
    const client = { getCheckoutStatus: vi.fn(async () => checkoutStatus({ isDirty: false })) };

    await fetchCheckoutStatus({ client, serverId, cwd });

    expect(useReviewDraftStore.getState().diffModeOverrides["review:scope"]).toBeUndefined();
  });
});

describe("applyCheckoutStatusUpdateFromEvent", () => {
  it("writes the checkout status to the cache using the cwd from the payload", () => {
    const queryClient = createQueryClient();
    const pushed = checkoutStatus({ requestId: "push-1", isDirty: true });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(pushed),
    });

    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toEqual(pushed);
  });

  it("writes the PR status cache when prStatus is present, and skips it otherwise", () => {
    const queryClient = createQueryClient();
    const pushedPr = prStatus({ requestId: "pr-1" });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus(), pushedPr),
    });
    expect(queryClient.getQueryData(checkoutPrStatusQueryKey(serverId, cwd))).toEqual(pushedPr);

    const otherCwd = "/repo2";
    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ cwd: otherCwd, repoRoot: otherCwd })),
    });
    expect(queryClient.getQueryData(checkoutPrStatusQueryKey(serverId, otherCwd))).toBeUndefined();
  });

  it("normalizes legacy PR auth state at the pushed-cache boundary", () => {
    const queryClient = createQueryClient();
    const { authState: _authState, ...legacyPrStatus } = prStatus({
      githubFeaturesEnabled: false,
    });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus(), legacyPrStatus),
    });

    expect(
      queryClient.getQueryData<CheckoutPrStatusPayload>(checkoutPrStatusQueryKey(serverId, cwd))
        ?.authState,
    ).toBe("unauthenticated");
    expect(
      queryClient.getQueryData<CheckoutStatusUpdate["payload"]>(
        checkoutStatusQueryKey(serverId, cwd),
      )?.prStatus?.authState,
    ).toBe("unauthenticated");
  });

  it("expires a manual diff-mode override when the pushed dirty state flipped", () => {
    const queryClient = createQueryClient();
    setDiffModeOverride(false);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ isDirty: true })),
    });

    expect(useReviewDraftStore.getState().diffModeOverrides["review:scope"]).toBeUndefined();
  });

  it("keeps a manual diff-mode override while the pushed dirty state still matches", () => {
    const queryClient = createQueryClient();
    setDiffModeOverride(true);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ isDirty: true })),
    });

    expect(useReviewDraftStore.getState().diffModeOverrides["review:scope"]).toBeDefined();
  });

  it("invalidates PR detail queries when the prStatus changes, ignoring the volatile requestId", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      checkoutPrStatusQueryKey(serverId, cwd),
      prStatus({ requestId: "pr-v1" }),
    );
    const timelineKey = prPaneTimelineQueryKey({ serverId, cwd, prNumber: 42 });
    const pipelineKey = prPanePipelineQueryKey({
      serverId,
      cwd,
      pipelineId: 9001,
      changeRequestNumber: 1,
    });
    queryClient.setQueryData(timelineKey, { items: [] });
    queryClient.setQueryData(pipelineKey, { stages: [] });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus(), prStatus({ requestId: "pr-v2" })),
    });
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(pipelineKey)?.isInvalidated).toBe(false);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(
        checkoutStatus(),
        prStatus({
          requestId: "pr-v3",
          status: { ...prStatus().status!, state: "closed" },
        }),
      ),
    });
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(pipelineKey)?.isInvalidated).toBe(true);
  });

  it("invalidates PR detail queries on the first prStatus emission, scoped to its cwd", () => {
    const queryClient = createQueryClient();
    const timelineKey = prPaneTimelineQueryKey({ serverId, cwd, prNumber: 42 });
    const otherTimelineKey = prPaneTimelineQueryKey({ serverId, cwd: "/repo2", prNumber: 42 });
    const pipelineKey = prPanePipelineQueryKey({
      serverId,
      cwd,
      pipelineId: 9001,
      changeRequestNumber: 1,
    });
    const otherPipelineKey = prPanePipelineQueryKey({
      serverId,
      cwd: "/repo2",
      pipelineId: 9001,
      changeRequestNumber: 1,
    });
    queryClient.setQueryData(timelineKey, { items: [] });
    queryClient.setQueryData(otherTimelineKey, { items: [] });
    queryClient.setQueryData(pipelineKey, { stages: [] });
    queryClient.setQueryData(otherPipelineKey, { stages: [] });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus(), prStatus()),
    });

    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherTimelineKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(pipelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherPipelineKey)?.isInvalidated).toBe(false);
  });
});
