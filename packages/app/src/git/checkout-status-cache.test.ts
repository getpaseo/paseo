// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import { checkoutCommitsQueryKey, checkoutStatusQueryKey } from "@/git/query-keys";
import { resetReviewDraftStore, useReviewDraftStore } from "@/review/store";
import {
  applyCheckoutStatusUpdateFromEvent,
  ensureCheckoutStatus,
  fetchCheckoutStatus,
  type CheckoutStatusPayload,
} from "./checkout-status-cache";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

const serverId = "server-1";
const targetA = {
  workspaceId: "workspace-a",
  cwd: "/workspace",
  queryIdentity: ["selected", "workspace-a"] as const,
};
const targetB = {
  workspaceId: "workspace-b",
  cwd: "/workspace",
  queryIdentity: ["selected", "workspace-b"] as const,
};

function status(
  target: { workspaceId: string; cwd: string } = targetA,
  branch = "main",
  isDirty = false,
): CheckoutStatusPayload {
  return {
    workspaceId: target.workspaceId,
    cwd: target.cwd,
    error: null,
    requestId: `status-${target.workspaceId}`,
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: target.cwd,
    mainRepoRoot: null,
    currentBranch: branch,
    isDirty,
    baseRef: "origin/main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: null,
  };
}

function update(payload: CheckoutStatusPayload): CheckoutStatusUpdate {
  return { type: "checkout_status_update", payload };
}

beforeEach(resetReviewDraftStore);

describe("selected checkout status cache", () => {
  it("fetches through the bound workspace capability", async () => {
    const getStatus = vi.fn(async () => status());
    await expect(
      fetchCheckoutStatus({ client: { getStatus }, serverId, target: targetA }),
    ).resolves.toEqual(status());
    expect(getStatus).toHaveBeenCalledWith();
  });

  it("deduplicates a bound status fetch by workspace identity", async () => {
    const client = new QueryClient();
    const getStatus = vi.fn(async () => status());
    const first = ensureCheckoutStatus({
      queryClient: client,
      client: { getStatus },
      serverId,
      target: targetA,
    });
    const second = ensureCheckoutStatus({
      queryClient: client,
      client: { getStatus },
      serverId,
      target: targetA,
    });
    await Promise.all([first, second]);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps same-cwd selected status and invalidation isolated", () => {
    const client = new QueryClient();
    client.setQueryData(checkoutStatusQueryKey(serverId, targetA), status(targetA, "a"));
    client.setQueryData(checkoutStatusQueryKey(serverId, targetB), status(targetB, "b"));
    client.setQueryData(checkoutCommitsQueryKey(serverId, targetA), { commits: [] });
    client.setQueryData(checkoutCommitsQueryKey(serverId, targetB), { commits: [] });

    applyCheckoutStatusUpdateFromEvent({
      queryClient: client,
      serverId,
      message: update(status(targetA, "a-next", true)),
    });

    expect(
      client.getQueryData<CheckoutStatusPayload>(checkoutStatusQueryKey(serverId, targetA))
        ?.currentBranch,
    ).toBe("a-next");
    expect(
      client.getQueryData<CheckoutStatusPayload>(checkoutStatusQueryKey(serverId, targetB))
        ?.currentBranch,
    ).toBe("b");
    expect(client.getQueryState(checkoutCommitsQueryKey(serverId, targetA))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(checkoutCommitsQueryKey(serverId, targetB))?.isInvalidated).toBe(
      false,
    );
  });

  it("expires a diff-mode override when a bound update changes dirty state", () => {
    useReviewDraftStore.getState().setDiffModeOverride({
      scopeKey: "review:scope",
      override: { serverId, cwd: targetA.cwd, mode: "base", isDirtyAtSelection: false },
    });
    applyCheckoutStatusUpdateFromEvent({
      queryClient: new QueryClient(),
      serverId,
      message: update(status(targetA, "main", true)),
    });
    expect(useReviewDraftStore.getState().diffModeOverrides["review:scope"]).toBeUndefined();
  });
});
