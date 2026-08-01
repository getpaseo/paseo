import { afterEach, describe, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  providerSubagentKey,
  refreshProviderSubagents,
  refreshProviderSubagentTimeline,
  useProviderSubagentStore,
} from "./provider-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

const SERVER_ID = "server-1";
const PARENT_ID = "parent-1";
const SUBAGENT_ID = "child-1";

afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

describe("provider subagent client store", () => {
  test("starts a fresh list request for each connection epoch", async () => {
    let requestCount = 0;
    const client = {
      async listProviderSubagents(parentAgentId: string) {
        requestCount += 1;
        return {
          requestId: `request-${requestCount}`,
          parentAgentId,
          subagents: [],
          error: null,
        };
      },
    };

    const first = refreshProviderSubagents(client, SERVER_ID, PARENT_ID, 1);
    const duplicate = refreshProviderSubagents(client, SERVER_ID, PARENT_ID, 1);
    expect(duplicate).toBe(first);
    await first;

    await refreshProviderSubagents(client, SERVER_ID, PARENT_ID, 2);
    expect(requestCount).toBe(2);
  });

  test("ignores a list response from a superseded connection epoch", async () => {
    type ListResponse = Awaited<ReturnType<DaemonClient["listProviderSubagents"]>>;
    const resolvers: Array<(response: ListResponse) => void> = [];
    const client = {
      listProviderSubagents() {
        return new Promise<ListResponse>((resolve) => resolvers.push(resolve));
      },
    };
    const currentSubagent = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "codex" as const,
      title: "Current child",
      description: null,
      status: "running" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: "call-1",
    };

    const staleRequest = refreshProviderSubagents(client, SERVER_ID, PARENT_ID, 1);
    const currentRequest = refreshProviderSubagents(client, SERVER_ID, PARENT_ID, 2);
    resolvers[1]?.({
      requestId: "current",
      parentAgentId: PARENT_ID,
      subagents: [currentSubagent],
      error: null,
    });
    await currentRequest;
    resolvers[0]?.({
      requestId: "stale",
      parentAgentId: PARENT_ID,
      subagents: [],
      error: null,
    });
    await staleRequest;

    expect(
      useProviderSubagentStore
        .getState()
        .descriptors.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID))?.title,
    ).toBe("Current child");
  });

  test("ignores a timeline response from a superseded connection epoch", async () => {
    type TimelineResponse = Awaited<ReturnType<DaemonClient["fetchProviderSubagentTimeline"]>>;
    const resolvers: Array<(response: TimelineResponse) => void> = [];
    const client = {
      fetchProviderSubagentTimeline() {
        return new Promise<TimelineResponse>((resolve) => resolvers.push(resolve));
      },
    };
    const response = (requestId: string, epoch: string, text: string): TimelineResponse => ({
      requestId,
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch,
      reset: true,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      hasOlder: false,
      hasNewer: false,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text },
        },
      ],
      error: null,
    });

    const staleRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      1,
      { direction: "tail", limit: 100 },
    );
    const currentRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      2,
      { direction: "tail", limit: 100 },
    );
    resolvers[1]?.(response("current", "timeline-current", "Current output."));
    await currentRequest;
    resolvers[0]?.(response("stale", "timeline-stale", "Stale output."));
    await staleRequest;

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.epoch).toBe("timeline-current");
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current output." }),
    ]);
  });

  test.each(["tail first", "pagination first"])(
    "preserves same-epoch reconnect tail and pagination when %s resolves",
    async (resolutionOrder) => {
      type TimelineResponse = Awaited<ReturnType<DaemonClient["fetchProviderSubagentTimeline"]>>;
      const resolvers = new Map<string, (response: TimelineResponse) => void>();
      const client = {
        fetchProviderSubagentTimeline(
          _parentAgentId: string,
          _subagentId: string,
          request: Parameters<DaemonClient["fetchProviderSubagentTimeline"]>[2],
        ) {
          return new Promise<TimelineResponse>((resolve) =>
            resolvers.set(request?.direction ?? "tail", resolve),
          );
        },
      };
      const response = (
        requestId: string,
        direction: "tail" | "before",
        seq: number,
        text: string,
        hasOlder: boolean,
      ): TimelineResponse => ({
        requestId,
        parentAgentId: PARENT_ID,
        subagentId: SUBAGENT_ID,
        provider: "codex",
        direction,
        epoch: "timeline-epoch",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
        hasOlder,
        hasNewer: direction === "before",
        rows: [
          {
            seq,
            timestamp: `2026-07-12T10:00:0${seq}.000Z`,
            item: { type: "assistant_message", text },
          },
        ],
        error: null,
      });
      useProviderSubagentStore
        .getState()
        .replaceTimeline(SERVER_ID, response("initial-tail", "tail", 2, "Recent output.", true));

      const paginationRequest = refreshProviderSubagentTimeline(
        client,
        SERVER_ID,
        PARENT_ID,
        SUBAGENT_ID,
        1,
        {
          direction: "before",
          cursor: { epoch: "timeline-epoch", seq: 2 },
          limit: 100,
        },
      );
      const reconnectTailRequest = refreshProviderSubagentTimeline(
        client,
        SERVER_ID,
        PARENT_ID,
        SUBAGENT_ID,
        1,
        { direction: "tail", limit: 100 },
      );
      const tailResponse = response("reconnect-tail", "tail", 2, "Current output.", true);
      const paginationResponse = response("older-page", "before", 1, "Older output.", false);

      if (resolutionOrder === "tail first") {
        resolvers.get("tail")?.(tailResponse);
        await reconnectTailRequest;
        resolvers.get("before")?.(paginationResponse);
      } else {
        resolvers.get("before")?.(paginationResponse);
        await Promise.resolve();
        resolvers.get("tail")?.(tailResponse);
      }
      await Promise.all([paginationRequest, reconnectTailRequest]);

      const timeline = useProviderSubagentStore
        .getState()
        .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
      expect(timeline?.hasOlder).toBe(false);
      expect([...timeline!.rows.keys()]).toEqual([2, 1]);
      expect(timeline?.head).toEqual([
        expect.objectContaining({
          kind: "assistant_message",
          text: "Older output.Recent output.",
        }),
      ]);
    },
  );

  test("discards an older page after a reconnect tail moves the history start", async () => {
    type TimelineResponse = Awaited<ReturnType<DaemonClient["fetchProviderSubagentTimeline"]>>;
    const resolvers = new Map<string, (response: TimelineResponse) => void>();
    const client = {
      fetchProviderSubagentTimeline(
        _parentAgentId: string,
        _subagentId: string,
        request: Parameters<DaemonClient["fetchProviderSubagentTimeline"]>[2],
      ) {
        return new Promise<TimelineResponse>((resolve) =>
          resolvers.set(request?.direction ?? "tail", resolve),
        );
      },
    };
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "initial-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "timeline-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Previous tail." },
        },
      ],
      error: null,
    });

    const olderRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      1,
      {
        direction: "before",
        cursor: { epoch: "timeline-epoch", seq: 2 },
        limit: 100,
      },
    );
    const tailRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      1,
      { direction: "tail", limit: 100 },
    );
    resolvers.get("tail")?.({
      requestId: "new-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "timeline-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 4,
          timestamp: "2026-07-12T10:00:04.000Z",
          item: { type: "assistant_message", text: "Current tail." },
        },
      ],
      error: null,
    });
    await tailRequest;
    const timelineAfterTail = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    resolvers.get("before")?.({
      requestId: "stale-older-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "before",
      epoch: "timeline-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Stale older output." },
        },
      ],
      error: null,
    });
    await olderRequest;

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline).toBe(timelineAfterTail);
    expect(timeline?.hasOlder).toBe(true);
    expect([...timeline!.rows.keys()]).toEqual([4]);
  });

  test("discards an older page after another page moves the history start", async () => {
    type TimelineResponse = Awaited<ReturnType<DaemonClient["fetchProviderSubagentTimeline"]>>;
    const resolvers: Array<(response: TimelineResponse) => void> = [];
    const client = {
      fetchProviderSubagentTimeline() {
        return new Promise<TimelineResponse>((resolve) => resolvers.push(resolve));
      },
    };
    useProviderSubagentStore.getState().replaceTimeline(SERVER_ID, {
      requestId: "initial-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "timeline-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Recent output." },
        },
      ],
      error: null,
    });

    const staleRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      1,
      {
        direction: "before",
        cursor: { epoch: "timeline-epoch", seq: 2 },
        limit: 100,
      },
    );
    const currentRequest = refreshProviderSubagentTimeline(
      client,
      SERVER_ID,
      PARENT_ID,
      SUBAGENT_ID,
      1,
      {
        direction: "before",
        cursor: { epoch: "timeline-epoch", seq: 2 },
        limit: 100,
      },
    );
    const olderPage = (requestId: string, hasOlder: boolean): TimelineResponse => ({
      requestId,
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "before",
      epoch: "timeline-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Older output." },
        },
      ],
      error: null,
    });
    resolvers[1]?.(olderPage("current-older-page", false));
    await currentRequest;
    const timelineAfterCurrentPage = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    resolvers[0]?.(olderPage("stale-older-page", true));
    await staleRequest;

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline).toBe(timelineAfterCurrentPage);
    expect(timeline?.hasOlder).toBe(false);
    expect([...timeline!.rows.keys()]).toEqual([2, 1]);
  });

  test("builds a shared stream model from ordered provider updates", () => {
    const subagents = useProviderSubagentStore.getState();
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "running",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:00.000Z",
        toolCallId: "call-1",
      },
    });
    subagents.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 2,
      timestamp: "2026-07-12T10:00:02.000Z",
      item: { type: "assistant_message", text: "New live output." },
    });
    subagents.replaceTimeline(SERVER_ID, {
      requestId: "history-1",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Older history." },
        },
      ],
      error: null,
    });
    const liveTimeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "running",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:01.500Z",
        toolCallId: "call-1",
      },
    });
    expect(
      useProviderSubagentStore
        .getState()
        .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBe(liveTimeline);
    subagents.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Explore",
        description: "Inspect the repository",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    const state = useProviderSubagentStore.getState();
    expect(state.descriptors.get(key)?.status).toBe("completed");
    expect(state.timelines.get(key)?.head).toEqual([]);
    expect(state.timelines.get(key)?.tail).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "Older history.New live output.",
      }),
    ]);
  });

  test("removes timelines for children no longer returned by the provider", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Removed child output." },
    });

    store.replaceList(SERVER_ID, PARENT_ID, []);

    expect(
      useProviderSubagentStore
        .getState()
        .timelines.has(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID)),
    ).toBe(false);
  });

  test("hides finished children locally without removing their timelines", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Finished child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Finished output." },
    });

    store.hideFinishedForParent(SERVER_ID, PARENT_ID);

    const state = useProviderSubagentStore.getState();
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(state.descriptors.get(key)?.title).toBe("Finished child");
    expect(state.hiddenFromTrack.has(key)).toBe(true);
    expect(state.timelines.get(key)?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Finished output." }),
    ]);
  });

  test("reveals a hidden child when the provider reports it running again", () => {
    const store = useProviderSubagentStore.getState();
    const completed = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "codex" as const,
      title: "Finished child",
      description: null,
      status: "completed" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:02.000Z",
      toolCallId: "call-1",
    };
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);
    store.replaceList(SERVER_ID, PARENT_ID, [completed]);

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(true);

    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: { ...completed, status: "running", updatedAt: "2026-07-12T10:01:00.000Z" },
    });

    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(false);
  });

  test("keeps hidden state when a child temporarily disappears from the provider list", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Finished child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);

    store.replaceList(SERVER_ID, PARENT_ID, []);

    const state = useProviderSubagentStore.getState();
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(state.descriptors.has(key)).toBe(false);
    expect(state.hiddenFromTrack.has(key)).toBe(true);
  });

  test("keeps a finished child hidden across remove and history replay", () => {
    const store = useProviderSubagentStore.getState();
    const completed = {
      id: SUBAGENT_ID,
      parentAgentId: PARENT_ID,
      provider: "codex" as const,
      title: "Finished child",
      description: null,
      status: "completed" as const,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:02.000Z",
      toolCallId: "call-1",
    };
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });
    store.hideFinishedForParent(SERVER_ID, PARENT_ID);
    store.applyUpdate(SERVER_ID, {
      kind: "remove",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
    });
    store.applyUpdate(SERVER_ID, { kind: "upsert", subagent: completed });

    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(key)).toBe(true);
  });
  test("applies terminal list status to a timeline received before its descriptor", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Restored output." },
    });
    const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
    expect(useProviderSubagentStore.getState().timelines.get(key)?.head).not.toEqual([]);

    store.replaceList(SERVER_ID, PARENT_ID, [
      {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Restored child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    ]);

    const timeline = useProviderSubagentStore.getState().timelines.get(key);
    expect(timeline?.head).toEqual([]);
    expect(timeline?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Restored output." }),
    ]);
  });

  test("keeps late timeline rows terminal after the descriptor completes", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: SUBAGENT_ID,
        parentAgentId: PARENT_ID,
        provider: "codex",
        title: "Restored child",
        description: null,
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
        toolCallId: "call-1",
      },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-07-12T10:00:01.000Z",
      item: { type: "assistant_message", text: "Late restored output." },
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.head).toEqual([]);
    expect(timeline?.tail).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Late restored output." }),
    ]);
  });

  test("merges bounded older pages and tracks whether more history remains", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "tail-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 2, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Recent output." },
        },
      ],
      error: null,
    });
    store.replaceTimeline(SERVER_ID, {
      requestId: "older-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "before",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Older output." },
        },
      ],
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.hasOlder).toBe(false);
    expect([...timeline!.rows.keys()]).toEqual([2, 1]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Older output.Recent output." }),
    ]);
  });

  test("ignores delayed live updates from a stale timeline epoch", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "current-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-current",
      reset: true,
      staleCursor: false,
      gap: false,
      window: { minSeq: 2, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:02.000Z",
          item: { type: "assistant_message", text: "Current output." },
        },
      ],
      error: null,
    });

    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-stale",
      seq: 3,
      timestamp: "2026-07-12T10:00:03.000Z",
      item: { type: "assistant_message", text: "Stale output." },
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.epoch).toBe("epoch-current");
    expect([...timeline!.rows.keys()]).toEqual([2]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current output." }),
    ]);
  });

  test("keeps loaded older history when an unchanged reconnect tail arrives", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      requestId: "old-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Current tail output." },
        },
      ],
      error: null,
    });
    store.replaceTimeline(SERVER_ID, {
      requestId: "older-page",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "before",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: true,
      rows: [
        {
          seq: 1,
          timestamp: "2026-07-12T09:59:00.000Z",
          item: { type: "assistant_message", text: "Older loaded output." },
        },
      ],
      error: null,
    });
    const timelineBeforeReconnect = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    store.replaceTimeline(SERVER_ID, {
      requestId: "reconnect-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 2,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Current tail output." },
        },
      ],
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline).toBe(timelineBeforeReconnect);
    expect(timeline?.hasOlder).toBe(false);
    expect([...timeline!.rows.keys()]).toEqual([2, 1]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "Older loaded output.Current tail output.",
      }),
    ]);
  });

  test("replaces a sparse range when a live row reaches the reconnect tail first", () => {
    const store = useProviderSubagentStore.getState();
    const timelineRow = (seq: number) => ({
      seq,
      timestamp: new Date(seq * 1_000).toISOString(),
      item: { type: "assistant_message" as const, text: `Output ${seq}.` },
    });
    store.replaceTimeline(SERVER_ID, {
      requestId: "initial-complete-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: false,
      rows: [timelineRow(1), timelineRow(2)],
      error: null,
    });
    store.applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "epoch-1",
      seq: 104,
      timestamp: new Date(104_000).toISOString(),
      item: timelineRow(104).item,
    });

    const firstTailSeq = 105 - TIMELINE_FETCH_PAGE_SIZE;
    const reconnectRows = Array.from({ length: TIMELINE_FETCH_PAGE_SIZE }, (_, index) =>
      timelineRow(firstTailSeq + index),
    );
    store.replaceTimeline(SERVER_ID, {
      requestId: "bounded-reconnect-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 104, nextSeq: 105 },
      hasOlder: true,
      hasNewer: false,
      rows: reconnectRows,
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(firstTailSeq).toBe(65);
    expect([...timeline!.rows.keys()]).toEqual(reconnectRows.map((row) => row.seq));
    expect(timeline?.lastSeq).toBe(104);
    expect(timeline?.hasOlder).toBe(true);
  });
});
