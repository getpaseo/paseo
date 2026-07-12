import { afterEach, describe, expect, test } from "vitest";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

const SERVER_ID = "server-1";
const PARENT_ID = "parent-1";
const SUBAGENT_ID = "child-1";

afterEach(() => {
  useProviderSubagentStore.setState({ descriptors: new Map(), timelines: new Map() });
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

  test("replaces cached rows with an authoritative tail page after a reconnect gap", () => {
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
    expect([...timeline!.rows.keys()]).toEqual([401]);
    expect(timeline?.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "Current tail output." }),
    ]);
  });
});
