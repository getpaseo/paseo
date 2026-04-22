import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutStatusResponse } from "@server/shared/messages";
import { checkoutStatusQueryKey, useCheckoutStatusQuery } from "./use-checkout-status-query";

type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

const { mockRuntime, mockClient, checkoutStatusUpdateHandlers } = vi.hoisted(() => {
  const checkoutStatusUpdateHandlers = new Set<(message: unknown) => void>();
  const mockClient = {
    getCheckoutStatus: vi.fn(),
    on: vi.fn((type: string, handler: (message: unknown) => void) => {
      if (type !== "checkout_status_update") {
        return () => {};
      }
      checkoutStatusUpdateHandlers.add(handler);
      return () => {
        checkoutStatusUpdateHandlers.delete(handler);
      };
    }),
  };

  return {
    mockClient,
    checkoutStatusUpdateHandlers,
    mockRuntime: {
      client: mockClient,
      isConnected: true,
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockRuntime.client,
  useHostRuntimeIsConnected: () => mockRuntime.isConnected,
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

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderCheckoutStatusHook({
  queryClient = createTestQueryClient(),
  hookCwd = cwd,
}: {
  queryClient?: QueryClient;
  hookCwd?: string;
} = {}) {
  let latest: ReturnType<typeof useCheckoutStatusQuery> | null = null;

  function Probe() {
    latest = useCheckoutStatusQuery({ serverId, cwd: hookCwd });
    return null;
  }

  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Missing root container");
  }

  const root = createRoot(container);

  return {
    get latest() {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    },
    async mount() {
      await act(async () => {
        root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Probe),
          ),
        );
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        vi.advanceTimersByTime(10);
        await Promise.resolve();
      });
    }
  }

  throw lastError;
}

async function emitCheckoutStatusUpdate(payload: CheckoutStatusPayload): Promise<void> {
  await act(async () => {
    for (const handler of checkoutStatusUpdateHandlers) {
      handler({
        type: "checkout_status_update",
        payload,
      });
    }
    await Promise.resolve();
  });
}

describe("useCheckoutStatusQuery", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost",
    });

    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
      configurable: true,
    });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });

    mockRuntime.client = mockClient;
    mockRuntime.isConnected = true;
    mockClient.getCheckoutStatus.mockReset();
    mockClient.on.mockClear();
    checkoutStatusUpdateHandlers.clear();
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  it("does not schedule polling after the cold read", async () => {
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus());
    const hook = renderCheckoutStatusHook();

    await hook.mount();
    await waitForExpectation(() => {
      expect(hook.latest.status?.currentBranch).toBe("main");
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mockClient.getCheckoutStatus).toHaveBeenCalledTimes(1);
  });

  it("returns the cached snapshot without calling the daemon", async () => {
    const queryClient = createTestQueryClient();
    const cached = checkoutStatus({ requestId: "cached" });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), cached);
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus({ requestId: "uncached" }));
    const hook = renderCheckoutStatusHook({ queryClient });

    await hook.mount();

    expect(hook.latest.status).toEqual(cached);
    expect(mockClient.getCheckoutStatus).not.toHaveBeenCalled();
  });

  it("fetches once on a cold read and uses cache on remount", async () => {
    const queryClient = createTestQueryClient();
    const fetched = checkoutStatus({ requestId: "cold-read" });
    mockClient.getCheckoutStatus.mockResolvedValue(fetched);
    const firstHook = renderCheckoutStatusHook({ queryClient });

    await firstHook.mount();
    await waitForExpectation(() => {
      expect(firstHook.latest.status).toEqual(fetched);
    });
    await firstHook.unmount();

    const secondHook = renderCheckoutStatusHook({ queryClient });
    await secondHook.mount();

    expect(secondHook.latest.status).toEqual(fetched);
    expect(mockClient.getCheckoutStatus).toHaveBeenCalledTimes(1);
  });

  it("does not refetch checkout status on focus or reconnect", async () => {
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus());
    const hook = renderCheckoutStatusHook();

    await hook.mount();
    await waitForExpectation(() => {
      expect(hook.latest.status?.currentBranch).toBe("main");
    });

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
    });

    expect(mockClient.getCheckoutStatus).toHaveBeenCalledTimes(1);
  });

  it("server-pushed checkout status update writes into the React Query cache at checkoutStatusQueryKey(serverId, cwd)", async () => {
    const queryClient = createTestQueryClient();
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus({ requestId: "initial" }));
    const hook = renderCheckoutStatusHook({ queryClient });

    await hook.mount();
    await waitForExpectation(() => {
      expect(hook.latest.status?.requestId).toBe("initial");
    });

    mockClient.getCheckoutStatus.mockClear();
    const pushed = checkoutStatus({
      requestId: "server-push",
      currentBranch: "pushed-branch",
      isDirty: true,
      aheadBehind: { ahead: 2, behind: 1 },
      aheadOfOrigin: 2,
      behindOfOrigin: 1,
    });
    await emitCheckoutStatusUpdate(pushed);

    expect(mockClient.getCheckoutStatus).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toEqual(pushed);
  });

  it("server push only updates the matching cwd's cache key, not other workspaces", async () => {
    const queryClient = createTestQueryClient();
    const otherCwd = "/other-repo";
    const otherCached = checkoutStatus({
      cwd: otherCwd,
      repoRoot: otherCwd,
      requestId: "other-cached",
      currentBranch: "other-main",
    });
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, otherCwd), otherCached);
    mockClient.getCheckoutStatus.mockResolvedValue(checkoutStatus({ requestId: "initial" }));
    const hook = renderCheckoutStatusHook({ queryClient });

    await hook.mount();
    await waitForExpectation(() => {
      expect(hook.latest.status?.requestId).toBe("initial");
    });

    const pushed = checkoutStatus({
      requestId: "server-push",
      currentBranch: "pushed-branch",
    });
    await emitCheckoutStatusUpdate(pushed);

    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, cwd))).toEqual(pushed);
    expect(queryClient.getQueryData(checkoutStatusQueryKey(serverId, otherCwd))).toEqual(
      otherCached,
    );
  });
});
