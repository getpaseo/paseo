import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, test } from "vitest";
import {
  observeProviderSubagentTimeline,
  providerSubagentKey,
  useProviderSubagentStore,
} from "./provider-store";

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
      projection: "projected",
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
    expect(
      state.timelines
        .get(key)
        ?.tail.map((item) => (item.kind === "assistant_message" ? item.text : ""))
        .join(""),
    ).toBe("Older history.New live output.");
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

    store.hideFromTrack(SERVER_ID, PARENT_ID, [SUBAGENT_ID]);

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
    store.hideFromTrack(SERVER_ID, PARENT_ID, [SUBAGENT_ID]);
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
    store.hideFromTrack(SERVER_ID, PARENT_ID, [SUBAGENT_ID]);

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
    store.hideFromTrack(SERVER_ID, PARENT_ID, [SUBAGENT_ID]);
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
      projection: "projected",
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
      projection: "projected",
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
    expect(timeline?.cursor).toMatchObject({ startSeq: 1, endSeq: 2 });
    expect([...(timeline?.tail ?? []), ...(timeline?.head ?? [])]).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Older output.Recent output." }),
    ]);
  });

  test("ignores delayed live updates from a stale timeline epoch", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      projection: "projected",
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
    expect(timeline?.cursor).toMatchObject({ startSeq: 2, endSeq: 2 });
    expect([...(timeline?.tail ?? []), ...(timeline?.head ?? [])]).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current output." }),
    ]);
  });

  test("replaces cached rows with an authoritative tail page after a reconnect gap", () => {
    const store = useProviderSubagentStore.getState();
    store.replaceTimeline(SERVER_ID, {
      projection: "projected",
      requestId: "old-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 500, nextSeq: 501 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 100,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Old cached output." },
        },
      ],
      error: null,
    });
    store.replaceTimeline(SERVER_ID, {
      projection: "projected",
      requestId: "reconnect-tail",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      direction: "tail",
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 500, nextSeq: 501 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 401,
          timestamp: "2026-07-12T10:00:01.000Z",
          item: { type: "assistant_message", text: "Current tail output." },
        },
      ],
      error: null,
    });

    const timeline = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID));
    expect(timeline?.cursor).toMatchObject({ startSeq: 401, endSeq: 401 });
    expect([...(timeline?.tail ?? []), ...(timeline?.head ?? [])]).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current tail output." }),
    ]);
  });
});

describe("projected child history", () => {
  const key = providerSubagentKey(SERVER_ID, PARENT_ID, SUBAGENT_ID);
  const timestamp = "2026-09-14T00:00:00.000Z";
  const current = () => useProviderSubagentStore.getState().timelines.get(key)!;
  const text = () =>
    [...current().tail, ...current().head]
      .map((item) => (item.kind === "assistant_message" ? item.text : ""))
      .join("");
  function stream(seq: number, value: string) {
    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "timeline",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "e",
      seq,
      timestamp,
      item: { type: "assistant_message", messageId: "m", text: value },
    });
  }
  type Payload = Parameters<
    ReturnType<typeof useProviderSubagentStore.getState>["replaceTimeline"]
  >[1];
  function response(
    value: string,
    seqStart: number,
    seqEnd: number,
    direction: "tail" | "after" = "tail",
  ): Payload {
    return {
      requestId: "r",
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      provider: "codex",
      epoch: "e",
      direction,
      projection: "projected",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: seqEnd, nextSeq: seqEnd + 1 },
      startCursor: { epoch: "e", seq: seqStart },
      endCursor: { epoch: "e", seq: seqEnd },
      hasOlder: false,
      hasNewer: false,
      error: null,
      rows: [
        {
          seq: seqEnd,
          seqStart,
          seqEnd,
          sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }],
          timestamp,
          item: { type: "assistant_message", messageId: "m", text: value },
        },
      ],
    };
  }
  function page(
    value: string,
    seqStart: number,
    seqEnd: number,
    direction: "tail" | "after" = "tail",
  ) {
    useProviderSubagentStore
      .getState()
      .replaceTimeline(SERVER_ID, response(value, seqStart, seqEnd, direction));
  }
  test("replaces overlapping fetched text and continues live streaming", () => {
    page("AB", 1, 2);
    stream(3, "C");
    page("ABCD", 1, 4, "after");
    expect(text()).toBe("ABCD");
    stream(5, "E");
    expect(text()).toBe("ABCDE");
  });
  test("reconciles a tail snapshot racing newer live text", () => {
    stream(1, "A");
    stream(2, "B");
    stream(3, "C");
    page("AB", 1, 2);
    page("ABC", 1, 3);
    expect(text()).toBe("ABC");
    expect(current().needsRefresh).toBe(false);
  });
  test("recovers a live sequence gap while observed and stops fetching when closed", async () => {
    let calls = 0;
    const client = {
      async fetchProviderSubagentTimeline() {
        calls++;
        return calls === 1 ? response("A", 1, 1) : response("ABC", 1, 3);
      },
    };
    const errors: unknown[] = [];
    const stop = observeProviderSubagentTimeline({
      client,
      serverId: SERVER_ID,
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      limit: 100,
      reportError: (error) => {
        errors.push(error);
      },
    });
    try {
      await expect.poll(() => current()?.cursor?.endSeq).toBe(1);
      stream(3, "C");
      await expect.poll(text).toBe("ABC");
      expect(calls).toBe(2);
      expect(current().needsRefresh).toBe(false);
    } finally {
      stop();
    }
    stream(5, "E");
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });
  test("retries a disconnected history read on the next stream update", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const stop = observeProviderSubagentTimeline({
      client: {
        async fetchProviderSubagentTimeline() {
          calls++;
          if (calls === 2) throw new DaemonConnectionError("Connection lost");
          return calls === 1 ? response("A", 1, 1) : response("ABCD", 1, 4);
        },
      },
      serverId: SERVER_ID,
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      limit: 100,
      reportError: (error) => {
        errors.push(error);
      },
    });
    try {
      await expect.poll(() => current()?.cursor?.endSeq).toBe(1);
      stream(3, "C");
      await expect.poll(() => calls).toBe(2);
      expect(current().needsRefresh).toBe(true);
      stream(4, "D");
      await expect.poll(text).toBe("ABCD");
      expect(current().needsRefresh).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });
  test("reports unexpected child history failures", async () => {
    const failure = new TypeError("Invalid child timeline response");
    const errors: unknown[] = [];
    const stop = observeProviderSubagentTimeline({
      client: {
        async fetchProviderSubagentTimeline() {
          throw failure;
        },
      },
      serverId: SERVER_ID,
      parentAgentId: PARENT_ID,
      subagentId: SUBAGENT_ID,
      limit: 100,
      reportError: (error) => {
        errors.push(error);
      },
    });
    try {
      await expect.poll(() => errors).toEqual([failure]);
    } finally {
      stop();
    }
  });
  test("keeps a completed tool at its original position after fetching its latest update", () => {
    const payload = response("Answer", 1, 5);
    payload.rows = [
      {
        seq: 5,
        seqStart: 1,
        seqEnd: 5,
        sourceSeqRanges: [
          { startSeq: 1, endSeq: 1 },
          { startSeq: 5, endSeq: 5 },
        ],
        timestamp,
        item: {
          type: "tool_call",
          callId: "t",
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "plain_text", label: "work" },
        },
      },
      {
        seq: 4,
        seqStart: 2,
        seqEnd: 4,
        sourceSeqRanges: [{ startSeq: 2, endSeq: 4 }],
        timestamp,
        item: { type: "assistant_message", text: "Answer", messageId: "m" },
      },
    ];
    useProviderSubagentStore.getState().replaceTimeline(SERVER_ID, payload);
    expect([...current().tail, ...current().head].map((item) => item.kind)).toEqual([
      "tool_call",
      "assistant_message",
    ]);
  });
  test("retains projected display state rather than cumulative tool snapshots", () => {
    for (let seq = 1; seq <= 2000; seq++) {
      useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
        kind: "timeline",
        parentAgentId: PARENT_ID,
        subagentId: SUBAGENT_ID,
        provider: "codex",
        epoch: "e",
        seq,
        timestamp,
        item: {
          type: "tool_call",
          callId: "tool",
          name: "task",
          status: "running",
          error: null,
          detail: { type: "sub_agent", description: "Child", log: "x".repeat(seq * 128) },
        },
      });
    }
    expect([...current().tail, ...current().head]).toHaveLength(1);
    expect(JSON.stringify(current()).length).toBeLessThan(1_000_000);
    expect(current().lastSeq).toBe(2000);
  });
});
