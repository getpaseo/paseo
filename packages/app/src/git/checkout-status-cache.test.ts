import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import {
  applyCheckoutStatusUpdate,
  type CheckoutStatusPayload,
  peekOrFetchCheckoutStatus,
} from "./checkout-status-cache";

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

function checkoutStatusUpdate(payload: CheckoutStatusPayload): CheckoutStatusUpdate {
  return { type: "checkout_status_update", payload };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("peekOrFetchCheckoutStatus", () => {
  it("fetches from the client and writes the result to the cache on a cold read", async () => {
    const queryClient = createQueryClient();
    const fetched = checkoutStatus({ requestId: "cold-read" });
    const client = { getCheckoutStatus: vi.fn(async () => fetched) };

    const result = await peekOrFetchCheckoutStatus({ queryClient, client, serverId, cwd });

    expect(result).toEqual(fetched);
    expect(client.getCheckoutStatus).toHaveBeenCalledExactlyOnceWith(cwd);
    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toEqual(fetched);
  });

  it("returns the cached snapshot without calling the client when the cache already has data", async () => {
    const queryClient = createQueryClient();
    const cached = checkoutStatus({ requestId: "cached" });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), cached);
    const client = {
      getCheckoutStatus: vi.fn(async () => checkoutStatus({ requestId: "uncached" })),
    };

    const result = await peekOrFetchCheckoutStatus({ queryClient, client, serverId, cwd });

    expect(result).toEqual(cached);
    expect(client.getCheckoutStatus).not.toHaveBeenCalled();
  });
});

describe("applyCheckoutStatusUpdate", () => {
  it("writes the pushed payload into the cache key for the matching cwd", () => {
    const queryClient = createQueryClient();
    const pushed = checkoutStatus({
      requestId: "server-push",
      currentBranch: "pushed-branch",
      isDirty: true,
      aheadBehind: { ahead: 2, behind: 1 },
      aheadOfOrigin: 2,
      behindOfOrigin: 1,
    });

    applyCheckoutStatusUpdate({
      queryClient,
      serverId,
      cwd,
      message: checkoutStatusUpdate(pushed),
    });

    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toEqual(pushed);
  });

  it("ignores updates whose payload cwd does not match the subscribed cwd", () => {
    const queryClient = createQueryClient();
    const otherCwd = "/other-repo";
    const otherCached = checkoutStatus({
      cwd: otherCwd,
      repoRoot: otherCwd,
      requestId: "other-cached",
      currentBranch: "other-main",
    });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, otherCwd), otherCached);

    applyCheckoutStatusUpdate({
      queryClient,
      serverId,
      cwd,
      message: checkoutStatusUpdate(
        checkoutStatus({
          cwd: otherCwd,
          repoRoot: otherCwd,
          requestId: "server-push",
          currentBranch: "pushed-branch",
        }),
      ),
    });

    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toBeUndefined();
    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, otherCwd))).toEqual(
      otherCached,
    );
  });
});
