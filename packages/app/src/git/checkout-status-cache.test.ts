// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import {
  checkoutCommitsQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
} from "@/git/query-keys";
import { draftAgentCommandsQueryKey } from "@/hooks/agent-commands-query";
import {
  prPanePipelineQueryKey,
  prPaneTimelineQueryKey,
} from "@/git/pull-request-panel/query-keys";
import {
  resetWorkingDiffComparisons,
  resolveWorkingDiffComparison,
  selectWorkingDiffComparison,
} from "@/git/working-diff-comparison";
import {
  applyCheckoutStatusUpdateFromEvent,
  ensureCheckoutStatus,
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
    headOid: "head-1",
    worktreeRevision: 1,
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

function selectBaseComparison(isDirtyAtSelection: boolean): void {
  selectWorkingDiffComparison({
    serverId,
    cwd,
    comparison: "base",
    isDirty: isDirtyAtSelection,
  });
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Mirrors how autocomplete consumes draft commands: the query is only enabled while the command
// menu is open (use-agent-autocomplete.ts), and provider discovery never expires on its own.
// Counting discoveries is the only way to tell "marked stale" apart from "refetched".
function mountCommandMenu(queryClient: QueryClient, loadCommands?: () => Promise<unknown[]>) {
  const queryKey = draftAgentCommandsQueryKey({
    serverId,
    draftConfig: { provider: "codex", cwd },
  });
  let discoveryCount = 0;
  const optionsFor = (enabled: boolean) => ({
    queryKey: [...queryKey],
    queryFn: async () => {
      discoveryCount += 1;
      return (await loadCommands?.()) ?? [];
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const observer = new QueryObserver(queryClient, optionsFor(false));
  const unsubscribe = observer.subscribe(() => {});
  return {
    queryKey,
    open: () => observer.setOptions(optionsFor(true)),
    close: () => observer.setOptions(optionsFor(false)),
    discoveryCount: () => discoveryCount,
    // Waiting on the counter alone is not enough: it advances when queryFn is entered, and a
    // later invalidation would be deduped into that still-in-flight fetch.
    settled: async (expectedDiscoveries: number) => {
      await vi.waitFor(() => {
        expect(discoveryCount).toBe(expectedDiscoveries);
        expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe("idle");
      });
    },
    unsubscribe,
  };
}

beforeEach(() => {
  resetWorkingDiffComparisons();
});

describe("fetchCheckoutStatus", () => {
  it("fetches from the client and returns the payload", async () => {
    const fetched = checkoutStatus({ requestId: "fetch-1" });
    const client = { getCheckoutStatus: vi.fn(async () => fetched) };

    const result = await fetchCheckoutStatus({ client, serverId, cwd });

    expect(result).toEqual(fetched);
    expect(client.getCheckoutStatus).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it("expires a manual working-diff comparison when the fetched dirty state flipped", async () => {
    selectBaseComparison(true);
    const client = { getCheckoutStatus: vi.fn(async () => checkoutStatus({ isDirty: false })) };

    await fetchCheckoutStatus({ client, serverId, cwd });

    expect(resolveWorkingDiffComparison({ serverId, cwd, isDirty: false })).toBe("base");
    expect(resolveWorkingDiffComparison({ serverId, cwd, isDirty: true })).toBe("uncommitted");
  });
});

describe("ensureCheckoutStatus", () => {
  it("awaits the canonical checkout-status query and reuses its cached result", async () => {
    const queryClient = createQueryClient();
    const fetched = checkoutStatus({ currentBranch: "feature/current" });
    const client = { getCheckoutStatus: vi.fn(async () => fetched) };

    const first = await ensureCheckoutStatus({ queryClient, client, serverId, cwd });
    const second = await ensureCheckoutStatus({ queryClient, client, serverId, cwd });

    expect(first).toEqual(fetched);
    expect(second).toEqual(fetched);
    expect(client.getCheckoutStatus).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it("awaits a refetch when the canonical cached status was invalidated", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      checkoutStatusQueryKey(serverId, cwd),
      checkoutStatus({ currentBranch: "feature/stale" }),
    );
    await queryClient.invalidateQueries({
      queryKey: checkoutStatusQueryKey(serverId, cwd),
      refetchType: "none",
    });
    const fetched = checkoutStatus({ currentBranch: "feature/current" });
    const client = { getCheckoutStatus: vi.fn(async () => fetched) };

    const result = await ensureCheckoutStatus({ queryClient, client, serverId, cwd });

    expect(result.currentBranch).toBe("feature/current");
    expect(client.getCheckoutStatus).toHaveBeenCalledExactlyOnceWith(cwd);
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

  it("invalidates recent commits when checkout status is pushed", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(checkoutCommitsQueryKey(serverId, cwd), { commits: [] });
    queryClient.setQueryData(checkoutCommitsQueryKey(serverId, "/repo2"), { commits: [] });

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus()),
    });

    expect(queryClient.getQueryState(checkoutCommitsQueryKey(serverId, cwd))?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(checkoutCommitsQueryKey(serverId, "/repo2"))?.isInvalidated,
    ).toBe(false);
  });

  it("invalidates draft command caches when the checkout branch changes", () => {
    const queryClient = createQueryClient();
    const draftCommandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd },
    });
    const otherDraftCommandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo2" },
    });
    queryClient.setQueryData(draftCommandsKey, []);
    queryClient.setQueryData(otherDraftCommandsKey, []);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ currentBranch: "feature/skills" })),
    });

    expect(queryClient.getQueryState(draftCommandsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDraftCommandsKey)?.isInvalidated).toBe(false);
  });

  it("invalidates draft command caches when HEAD changes on the same branch", () => {
    const queryClient = createQueryClient();
    const draftCommandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd },
    });
    queryClient.setQueryData(draftCommandsKey, []);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ headOid: "head-2" })),
    });

    expect(queryClient.getQueryState(draftCommandsKey)?.isInvalidated).toBe(true);
  });

  it("invalidates draft command caches when a detached HEAD changes", () => {
    const queryClient = createQueryClient();
    const draftCommandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd },
    });
    queryClient.setQueryData(draftCommandsKey, []);
    queryClient.setQueryData(
      checkoutStatusQueryKey(serverId, cwd),
      checkoutStatus({ currentBranch: null }),
    );

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ currentBranch: null, headOid: "head-2" })),
    });

    expect(queryClient.getQueryState(draftCommandsKey)?.isInvalidated).toBe(true);
  });

  it("does not rediscover commands in an open menu on a working-tree status update", async () => {
    const queryClient = createQueryClient();
    const menu = mountCommandMenu(queryClient);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());
    menu.open();
    await menu.settled(1);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(
        checkoutStatus({ isDirty: true, requestId: "push-2", worktreeRevision: 2 }),
      ),
    });
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(menu.queryKey)?.isInvalidated).toBe(true),
    );

    expect(menu.discoveryCount()).toBe(1);
    menu.unsubscribe();
  });

  it("rediscovers commands the next time the menu opens after a working-tree status update", async () => {
    const queryClient = createQueryClient();
    const menu = mountCommandMenu(queryClient);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());
    menu.open();
    await menu.settled(1);
    menu.close();

    // An external tool adds an uncommitted project skill: same branch, same HEAD, dirty tree.
    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(
        checkoutStatus({ isDirty: true, requestId: "push-2", worktreeRevision: 2 }),
      ),
    });
    menu.open();

    await menu.settled(2);
    menu.unsubscribe();
  });

  it("keeps the next-open invalidation after an in-flight discovery settles", async () => {
    const queryClient = createQueryClient();
    let resolveDiscovery!: (commands: unknown[]) => void;
    const discovery = new Promise<unknown[]>((resolve) => {
      resolveDiscovery = resolve;
    });
    const menu = mountCommandMenu(queryClient, () => discovery);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());
    menu.open();
    await vi.waitFor(() => expect(menu.discoveryCount()).toBe(1));

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(
        checkoutStatus({ isDirty: true, requestId: "push-2", worktreeRevision: 2 }),
      ),
    });
    resolveDiscovery([]);

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(menu.queryKey)?.isInvalidated).toBe(true),
    );
    menu.close();
    menu.open();
    await menu.settled(2);
    menu.unsubscribe();
  });

  it("rediscovers commands in an open menu when the checkout identity changes", async () => {
    const queryClient = createQueryClient();
    const menu = mountCommandMenu(queryClient);
    queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), checkoutStatus());
    menu.open();
    await menu.settled(1);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ currentBranch: "feature/skills" })),
    });

    await menu.settled(2);
    menu.unsubscribe();
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

  it("expires a manual working-diff comparison when the pushed dirty state flipped", () => {
    const queryClient = createQueryClient();
    selectBaseComparison(false);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ isDirty: true })),
    });

    expect(resolveWorkingDiffComparison({ serverId, cwd, isDirty: true })).toBe("uncommitted");
  });

  it("keeps a manual working-diff comparison while the pushed dirty state still matches", () => {
    const queryClient = createQueryClient();
    selectBaseComparison(true);

    applyCheckoutStatusUpdateFromEvent({
      queryClient,
      serverId,
      message: checkoutStatusUpdate(checkoutStatus({ isDirty: true })),
    });

    expect(resolveWorkingDiffComparison({ serverId, cwd, isDirty: true })).toBe("base");
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
