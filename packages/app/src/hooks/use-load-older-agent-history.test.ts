import { describe, expect, it } from "vitest";
import type { ToastApi, ToastShowOptions } from "@/components/toast-host";
import type { AgentTimelineCursorState } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import {
  loadAllOlderAgentHistory,
  loadOlderAgentHistory,
  type LoadOlderAgentHistoryClient,
} from "./use-load-older-agent-history";

const agentId = "agent-1";

interface FakeClient extends LoadOlderAgentHistoryClient {
  calls: Array<{
    agentId: string;
    request: Parameters<LoadOlderAgentHistoryClient["fetchAgentTimeline"]>[1];
  }>;
}

function createClient(behavior: () => Promise<void> = async () => undefined): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    fetchAgentTimeline: async (id, request) => {
      calls.push({ agentId: id, request });
      await behavior();
    },
  };
}

interface FakeInFlight {
  values: boolean[];
  setInFlight(value: boolean): void;
  get current(): boolean;
}

function createInFlight(initial = false): FakeInFlight {
  const values: boolean[] = [initial];
  return {
    values,
    setInFlight(value) {
      values.push(value);
    },
    get current() {
      return values[values.length - 1] ?? initial;
    },
  };
}

interface FakeToast extends ToastApi {
  shown: Array<{ message: unknown; options: ToastShowOptions | undefined }>;
}

function createToast(): FakeToast {
  const shown: FakeToast["shown"] = [];
  return {
    shown,
    show: (message, options) => {
      shown.push({ message, options });
    },
    copied: () => {},
    error: () => {},
  };
}

interface FakeLogger {
  warnings: unknown[][];
  warn: (...args: unknown[]) => void;
}

function createLogger(): FakeLogger {
  const warnings: unknown[][] = [];
  return {
    warnings,
    warn: (...args) => {
      warnings.push(args);
    },
  };
}

const someCursor: AgentTimelineCursorState = { epoch: "epoch-1", startSeq: 10, endSeq: 20 };

describe("loadOlderAgentHistory", () => {
  it("no-ops without a cursor", async () => {
    const client = createClient();
    const inFlight = createInFlight();

    const started = await loadOlderAgentHistory(agentId, {
      client,
      cursor: undefined,
      hasOlder: true,
      isLoadingOlder: false,
      setInFlight: inFlight.setInFlight,
    });

    expect(client.calls).toEqual([]);
    expect(inFlight.values).toEqual([false]);
    expect(started).toBe(false);
  });

  it("no-ops when the daemon says no older history exists", async () => {
    const client = createClient();
    const inFlight = createInFlight();

    const started = await loadOlderAgentHistory(agentId, {
      client,
      cursor: someCursor,
      hasOlder: false,
      isLoadingOlder: false,
      setInFlight: inFlight.setInFlight,
    });

    expect(client.calls).toEqual([]);
    expect(inFlight.values).toEqual([false]);
    expect(started).toBe(false);
  });

  it("no-ops when a request is already in flight", async () => {
    const client = createClient();
    const inFlight = createInFlight(true);

    const started = await loadOlderAgentHistory(agentId, {
      client,
      cursor: someCursor,
      hasOlder: true,
      isLoadingOlder: true,
      setInFlight: inFlight.setInFlight,
    });

    expect(client.calls).toEqual([]);
    expect(inFlight.values).toEqual([true]);
    expect(started).toBe(true);
  });

  it("requests the page before the current start cursor and clears in-flight on success", async () => {
    const client = createClient();
    const inFlight = createInFlight();

    const started = await loadOlderAgentHistory(agentId, {
      client,
      cursor: someCursor,
      hasOlder: true,
      isLoadingOlder: false,
      setInFlight: inFlight.setInFlight,
    });

    expect(client.calls).toEqual([
      {
        agentId,
        request: {
          direction: "before",
          cursor: { epoch: "epoch-1", seq: 10 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(inFlight.values).toEqual([false, true, false]);
    expect(started).toBe(true);
  });

  it("shows a panel toast, warns, and clears in-flight on failure", async () => {
    const error = new Error("network");
    const client = createClient(async () => {
      throw error;
    });
    const inFlight = createInFlight();
    const toast = createToast();
    const logger = createLogger();

    await loadOlderAgentHistory(agentId, {
      client,
      cursor: someCursor,
      hasOlder: true,
      isLoadingOlder: false,
      setInFlight: inFlight.setInFlight,
      toast,
      logger,
    });

    expect(client.calls).toHaveLength(1);
    expect(toast.shown).toEqual([
      {
        message: "Couldn't load older history",
        options: { durationMs: 2200, testID: "agent-load-older-history-toast" },
      },
    ]);
    expect(logger.warnings).toEqual([
      ["[Timeline] failed to load older agent history", agentId, error],
    ]);
    expect(inFlight.values).toEqual([false, true, false]);
  });

  it("shares a single cursor request between scroll and search callers", async () => {
    let resolveRequest: (() => void) | undefined;
    const client = createClient(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const inFlight = createInFlight();
    const deps = {
      client,
      cursor: someCursor,
      hasOlder: true,
      isLoadingOlder: false,
      setInFlight: inFlight.setInFlight,
    };

    const first = loadOlderAgentHistory(agentId, deps, "shared");
    const second = loadOlderAgentHistory(agentId, { ...deps, isLoadingOlder: true }, "shared");
    expect(client.calls).toHaveLength(1);
    resolveRequest?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["loaded", "loaded"]);
  });

  it("backfills sequential 100-item pages and can stop between pages", async () => {
    const requests: number[] = [];
    let page = 0;
    let continueLoading = true;
    const deps = () => ({
      client: {
        fetchAgentTimeline: async (_id: string, request: { limit: number }) => {
          requests.push(request.limit);
          page += 1;
          if (page === 2) {
            continueLoading = false;
          }
        },
      },
      cursor: { ...someCursor, startSeq: 10 - page },
      hasOlder: page < 4,
      isLoadingOlder: false,
      setInFlight: () => {},
    });

    await expect(
      loadAllOlderAgentHistory({
        agentId,
        requestKey: "backfill",
        getDeps: deps,
        shouldContinue: () => continueLoading,
      }),
    ).resolves.toBe("complete");
    expect(requests).toEqual([TIMELINE_FETCH_PAGE_SIZE, TIMELINE_FETCH_PAGE_SIZE]);
  });

  it("stops full-history backfill on failure so it can be retried", async () => {
    const client = createClient(async () => {
      throw new Error("offline");
    });
    await expect(
      loadAllOlderAgentHistory({
        agentId,
        requestKey: "failure",
        getDeps: () => ({
          client,
          cursor: someCursor,
          hasOlder: true,
          isLoadingOlder: false,
          setInFlight: () => {},
          logger: { warn: () => {} },
        }),
        shouldContinue: () => true,
      }),
    ).resolves.toBe("failed");
    expect(client.calls).toHaveLength(1);
  });
});
