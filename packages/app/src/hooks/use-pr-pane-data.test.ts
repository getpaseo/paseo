import { describe, expect, it } from "vitest";
import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@getpaseo/protocol/messages";
import {
  createInMemoryUnsupportedTimelineRegistry,
  extractPrRepoIdentity,
  fetchPrPaneTimelinePage,
  isUnsupportedTimelineError,
  type PrPaneTimelineClient,
  selectPrPaneState,
  shouldFetchTimelineFrom,
  unsupportedTimelineKey,
} from "./use-pr-pane-data";

type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>;
type PullRequestTimelinePayload = PullRequestTimelineResponse["payload"];
type PullRequestTimelineInput = Parameters<PrPaneTimelineClient["pullRequestTimeline"]>[0];

const githubStatus: CheckoutPrStatus["github"] = {
  mergeStateStatus: null,
  autoMergeRequest: null,
  viewerCanEnableAutoMerge: false,
  viewerCanDisableAutoMerge: false,
  viewerCanMergeAsAdmin: false,
  viewerCanUpdateBranch: false,
  repository: {
    autoMergeAllowed: false,
    mergeCommitAllowed: false,
    squashMergeAllowed: false,
    rebaseMergeAllowed: false,
    viewerDefaultMergeMethod: null,
  },
  isMergeQueueEnabled: false,
  isInMergeQueue: false,
};

function prStatus(overrides: Partial<CheckoutPrStatus> = {}): CheckoutPrStatus {
  return {
    number: 42,
    url: "https://github.com/getpaseo/paseo/pull/42",
    title: "Wire real PR pane data",
    state: "open",
    baseRefName: "main",
    headRefName: "feature/pr-pane",
    isMerged: false,
    isDraft: false,
    mergeable: "UNKNOWN",
    checks: [],
    reviewDecision: null,
    repoOwner: "getpaseo",
    repoName: "paseo",
    github: githubStatus,
    ...overrides,
  };
}

function timelinePayload(
  overrides: Partial<PullRequestTimelinePayload> = {},
): PullRequestTimelinePayload {
  return {
    cwd: "/repo",
    prNumber: 42,
    items: [],
    truncated: false,
    error: null,
    requestId: "timeline-1",
    githubFeaturesEnabled: true,
    ...overrides,
  };
}

interface FakeTimelineClient extends PrPaneTimelineClient {
  calls: PullRequestTimelineInput[];
}

function createTimelineClient(
  respond: (input: PullRequestTimelineInput) => Promise<PullRequestTimelinePayload>,
): FakeTimelineClient {
  const calls: PullRequestTimelineInput[] = [];
  return {
    calls,
    pullRequestTimeline: async (input) => {
      calls.push(input);
      return respond(input);
    },
  };
}

function unsupportedTimelineError(): Error {
  const error = new Error(
    "Unknown request, try upgrading the daemon requestType=pull_request_timeline_request code=unknown_schema",
  ) as Error & { code: string; requestType: string };
  error.name = "DaemonRpcError";
  error.code = "unknown_schema";
  error.requestType = "pull_request_timeline_request";
  return error;
}

const baseSelectInput = {
  status: null as CheckoutPrStatus | null,
  statusPayloadError: null,
  statusError: null as Error | null,
  statusIsLoading: false,
  statusIsFetching: false,
  githubFeaturesEnabled: true,
  timelineEnabled: true,
  shouldFetchTimeline: true,
  timelinePayload: undefined as PullRequestTimelinePayload | undefined,
  timelineError: null as Error | null,
  timelineIsLoading: false,
  timelineIsFetching: false,
};

describe("extractPrRepoIdentity", () => {
  it("reads the PR number, owner, and name from a status payload", () => {
    expect(extractPrRepoIdentity(prStatus())).toEqual({
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });
  });

  it("returns null fields when the status is missing", () => {
    expect(extractPrRepoIdentity(null)).toEqual({
      prNumber: null,
      repoOwner: null,
      repoName: null,
    });
  });

  it("treats empty owner or name strings as missing", () => {
    expect(extractPrRepoIdentity(prStatus({ repoOwner: "", repoName: "" }))).toMatchObject({
      repoOwner: null,
      repoName: null,
    });
  });

  it("reports no PR number when the status omits it", () => {
    const status = prStatus();
    delete status.number;
    expect(extractPrRepoIdentity(status).prNumber).toBeNull();
  });
});

describe("shouldFetchTimelineFrom", () => {
  const baseGate = {
    hasClient: true,
    isConnected: true,
    timelineEnabled: true,
    githubFeaturesEnabled: true,
    cwd: "/repo",
    identity: { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo" },
    timelineUnsupported: false,
  };

  it("fetches when every gate is open", () => {
    expect(shouldFetchTimelineFrom(baseGate)).toBe(true);
  });

  it.each([
    { name: "no client", overrides: { hasClient: false } },
    { name: "disconnected", overrides: { isConnected: false } },
    { name: "timeline disabled", overrides: { timelineEnabled: false } },
    { name: "github features off", overrides: { githubFeaturesEnabled: false } },
    { name: "empty cwd", overrides: { cwd: "" } },
    {
      name: "missing PR number",
      overrides: { identity: { ...baseGate.identity, prNumber: null } },
    },
    { name: "missing owner", overrides: { identity: { ...baseGate.identity, repoOwner: null } } },
    { name: "missing name", overrides: { identity: { ...baseGate.identity, repoName: null } } },
    { name: "tuple marked unsupported", overrides: { timelineUnsupported: true } },
  ])("skips fetching when $name", ({ overrides }) => {
    expect(shouldFetchTimelineFrom({ ...baseGate, ...overrides })).toBe(false);
  });
});

describe("createInMemoryUnsupportedTimelineRegistry", () => {
  it("remembers added keys and answers has() against them", () => {
    const registry = createInMemoryUnsupportedTimelineRegistry();
    const key = unsupportedTimelineKey({ serverId: "host", cwd: "/repo", prNumber: 99 });

    expect(registry.has(key)).toBe(false);
    registry.add(key);
    expect(registry.has(key)).toBe(true);
  });

  it("uses serverId, cwd, and prNumber to scope each key", () => {
    expect(unsupportedTimelineKey({ serverId: "host-a", cwd: "/repo", prNumber: 1 })).not.toEqual(
      unsupportedTimelineKey({ serverId: "host-b", cwd: "/repo", prNumber: 1 }),
    );
    expect(unsupportedTimelineKey({ serverId: "host", cwd: "/repo-a", prNumber: 1 })).not.toEqual(
      unsupportedTimelineKey({ serverId: "host", cwd: "/repo-b", prNumber: 1 }),
    );
    expect(unsupportedTimelineKey({ serverId: "host", cwd: "/repo", prNumber: 1 })).not.toEqual(
      unsupportedTimelineKey({ serverId: "host", cwd: "/repo", prNumber: 2 }),
    );
  });
});

describe("fetchPrPaneTimelinePage", () => {
  it("forwards the cwd, PR number, owner, and name to the daemon client", async () => {
    const client = createTimelineClient(async () => timelinePayload());
    const registry = createInMemoryUnsupportedTimelineRegistry();

    await fetchPrPaneTimelinePage({
      client,
      registry,
      serverId: "host",
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });

    expect(client.calls).toEqual([
      { cwd: "/repo", prNumber: 42, repoOwner: "getpaseo", repoName: "paseo" },
    ]);
  });

  it("returns the daemon's timeline payload on success", async () => {
    const payload = timelinePayload({
      items: [
        {
          id: "comment-1",
          kind: "comment",
          author: "octocat",
          body: "Looks good",
          createdAt: Date.now(),
          url: "https://github.com/getpaseo/paseo/pull/42#c1",
        },
      ],
    });
    const client = createTimelineClient(async () => payload);
    const registry = createInMemoryUnsupportedTimelineRegistry();

    const result = await fetchPrPaneTimelinePage({
      client,
      registry,
      serverId: "host",
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });

    expect(result).toBe(payload);
  });

  it("records the tuple in the registry when the daemon rejects the request as unsupported", async () => {
    const error = unsupportedTimelineError();
    const client = createTimelineClient(async () => {
      throw error;
    });
    const registry = createInMemoryUnsupportedTimelineRegistry();

    await expect(
      fetchPrPaneTimelinePage({
        client,
        registry,
        serverId: "host",
        cwd: "/repo",
        prNumber: 99,
        repoOwner: "getpaseo",
        repoName: "paseo",
      }),
    ).rejects.toBe(error);

    expect(
      registry.has(unsupportedTimelineKey({ serverId: "host", cwd: "/repo", prNumber: 99 })),
    ).toBe(true);
  });

  it("leaves the registry alone when the failure is a generic error", async () => {
    const error = new Error("network down");
    const client = createTimelineClient(async () => {
      throw error;
    });
    const registry = createInMemoryUnsupportedTimelineRegistry();

    await expect(
      fetchPrPaneTimelinePage({
        client,
        registry,
        serverId: "host",
        cwd: "/repo",
        prNumber: 99,
        repoOwner: "getpaseo",
        repoName: "paseo",
      }),
    ).rejects.toBe(error);

    expect(
      registry.has(unsupportedTimelineKey({ serverId: "host", cwd: "/repo", prNumber: 99 })),
    ).toBe(false);
  });

  it("scopes recorded tuples per serverId+cwd+prNumber so other PRs can still be tried", async () => {
    const client = createTimelineClient(async (input) => {
      if (input.cwd === "/repo-a") {
        throw unsupportedTimelineError();
      }
      return timelinePayload({ cwd: input.cwd, prNumber: input.prNumber });
    });
    const registry = createInMemoryUnsupportedTimelineRegistry();

    await expect(
      fetchPrPaneTimelinePage({
        client,
        registry,
        serverId: "host",
        cwd: "/repo-a",
        prNumber: 1,
        repoOwner: "getpaseo",
        repoName: "paseo",
      }),
    ).rejects.toThrow();

    const result = await fetchPrPaneTimelinePage({
      client,
      registry,
      serverId: "host",
      cwd: "/repo-b",
      prNumber: 2,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });

    expect(result.prNumber).toBe(2);
    expect(
      registry.has(unsupportedTimelineKey({ serverId: "host", cwd: "/repo-a", prNumber: 1 })),
    ).toBe(true);
    expect(
      registry.has(unsupportedTimelineKey({ serverId: "host", cwd: "/repo-b", prNumber: 2 })),
    ).toBe(false);
  });
});

describe("isUnsupportedTimelineError", () => {
  it("matches the daemon's unknown-schema error for pull_request_timeline_request", () => {
    expect(isUnsupportedTimelineError(unsupportedTimelineError())).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isUnsupportedTimelineError(new Error("network down"))).toBe(false);
    expect(isUnsupportedTimelineError("not an error")).toBe(false);
  });

  it("rejects daemon errors for a different request type", () => {
    const error = new Error("nope") as Error & { code: string; requestType: string };
    error.name = "DaemonRpcError";
    error.code = "unknown_schema";
    error.requestType = "something_else_request";
    expect(isUnsupportedTimelineError(error)).toBe(false);
  });
});

describe("selectPrPaneState", () => {
  it("returns null data and no PR number when the status payload has no PR", () => {
    const state = selectPrPaneState({ ...baseSelectInput, status: null });

    expect(state.data).toBeNull();
    expect(state.prNumber).toBeNull();
  });

  it("composes data from status and timeline when both are present", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      timelinePayload: timelinePayload(),
    });

    expect(state.data?.number).toBe(42);
    expect(state.data?.title).toBe("Wire real PR pane data");
    expect(state.data?.activity).toEqual([]);
  });

  it("returns null data when the consumer disabled timeline rendering", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      timelineEnabled: false,
      timelinePayload: timelinePayload(),
    });

    expect(state.data).toBeNull();
    expect(state.prNumber).toBe(42);
  });

  it("drops timeline activity that belongs to a different PR number", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      timelinePayload: timelinePayload({
        prNumber: 41,
        items: [
          {
            id: "comment-1",
            kind: "comment",
            author: "octocat",
            body: "Belongs to another PR",
            createdAt: Date.now(),
            url: "https://github.com/getpaseo/paseo/pull/41#c1",
          },
        ],
      }),
    });

    expect(state.data?.activity).toEqual([]);
  });

  it("reports loading while the status query is loading", () => {
    expect(selectPrPaneState({ ...baseSelectInput, statusIsLoading: true }).isLoading).toBe(true);
  });

  it("reports loading while the timeline is still pending its first response", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      shouldFetchTimeline: true,
      timelineIsLoading: true,
    });
    expect(state.isLoading).toBe(true);
  });

  it("does not report loading on the timeline when no fetch was scheduled", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      shouldFetchTimeline: false,
      timelineIsLoading: true,
    });
    expect(state.isLoading).toBe(false);
  });

  it("reports refreshing during background revalidation of either query", () => {
    expect(
      selectPrPaneState({
        ...baseSelectInput,
        statusIsFetching: true,
      }).isRefreshing,
    ).toBe(true);
    expect(
      selectPrPaneState({
        ...baseSelectInput,
        timelineIsFetching: true,
      }).isRefreshing,
    ).toBe(true);
  });

  it("surfaces status payload errors with the daemon's message", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      statusPayloadError: { code: "UNKNOWN", message: "bad daemon payload" },
    });

    expect(state.error?.message).toContain("bad daemon payload");
  });

  it("falls back to a generic message when the status payload error is empty", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      statusPayloadError: { code: "UNKNOWN", message: "" },
    });

    expect(state.error?.message).toBe("Unable to load pull request status");
  });

  it("prefers the status thrown error over the timeline error", () => {
    const statusError = new Error("status broke");
    const state = selectPrPaneState({
      ...baseSelectInput,
      statusError,
      timelineError: new Error("timeline broke"),
    });

    expect(state.error).toBe(statusError);
  });

  it("suppresses unsupported timeline errors", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      timelineError: unsupportedTimelineError(),
    });

    expect(state.error).toBeNull();
  });

  it("surfaces timeline payload errors when nothing earlier failed", () => {
    const state = selectPrPaneState({
      ...baseSelectInput,
      status: prStatus(),
      timelinePayload: timelinePayload({ error: { kind: "unknown", message: "rate limited" } }),
    });

    expect(state.error?.message).toBe("rate limited");
  });

  it("passes the daemon's githubFeaturesEnabled flag through", () => {
    expect(
      selectPrPaneState({
        ...baseSelectInput,
        status: prStatus(),
        githubFeaturesEnabled: false,
      }).githubFeaturesEnabled,
    ).toBe(false);
  });
});
