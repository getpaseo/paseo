import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem, ConversationRewindCut } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import type { AgentTimelineFetchResult, AgentTimelineRow } from "../agent-timeline-store-types.js";
import { DeferredTimelineBackend } from "./testing.js";
import { selectReferenceProjectedTimelinePage } from "../test-utils/timeline-page-reference.js";
import {
  AgentTimeline,
  TimelineRewindBoundaryError,
  TimelineRewindPendingError,
  TimelineRewindTargetError,
  type TimelineCommit,
  type TimelineEntry,
  type TimelineRetirementCommit,
  type TimelineRewindCompletion,
  type TimelineScope,
} from "./index.js";
import { UnknownTimelineError } from "./internal/backend.js";

const root = (agentId: string): TimelineScope => ({ agentId });

async function append(
  timeline: AgentTimeline,
  agentId: string,
  item: AgentTimelineItem,
  options?: { turnId?: string },
): Promise<AgentTimelineRow> {
  const { commits } = await timeline.append(root(agentId), [{ item, ...options }]);
  const [commit] = commits;
  return commit.row;
}

describe.each([
  ["memory", () => new AgentTimeline()],
  ["deferred", () => new AgentTimeline(new DeferredTimelineBackend())],
])("AgentTimeline over a %s backend", (_name, createTimeline) => {
  it("lets a read observe writes called before it without awaiting them", async () => {
    const timeline = createTimeline();
    void timeline.create(root("a"), { epoch: "e" });
    const published: number[] = [];
    for (const text of ["one", "two", "three"]) {
      void timeline.ingest(
        root("a"),
        { item: { type: "user_message", text } },
        { publish: ({ row }) => published.push(row.seq) },
      );
    }
    const rows = await timeline.readRows(root("a"));
    expect(rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "one" },
      { type: "user_message", text: "two" },
      { type: "user_message", text: "three" },
    ]);
    expect(published).toEqual([1, 2, 3]);
  });

  it("publishes each commit before the next operation starts", async () => {
    const timeline = createTimeline();
    await timeline.create(root("a"), { epoch: "e" });
    const order: string[] = [];
    const first = timeline.ingest(
      root("a"),
      { item: { type: "assistant_message", text: "A" } },
      { publish: () => order.push("publish A") },
    );
    const settled = timeline.settled(root("a")).then(() => order.push("settled"));
    const second = timeline.ingest(
      root("a"),
      { item: { type: "assistant_message", text: "B" } },
      { publish: () => order.push("publish B") },
    );
    await Promise.all([first, settled, second]);
    expect(order).toEqual(["publish A", "settled", "publish B"]);
  });

  it("rejects a failed write without publishing it or consuming a sequence number", async () => {
    const backend = new DeferredTimelineBackend();
    const timeline = new AgentTimeline(backend);
    await timeline.create(root("a"), { epoch: "e" });
    const published: TimelineCommit[] = [];
    backend.failNextAppend = true;
    const failed = timeline.ingest(
      root("a"),
      { item: { type: "user_message", text: "lost" } },
      { publish: (commit) => published.push(commit) },
    );
    const next = timeline.ingest(
      root("a"),
      { item: { type: "user_message", text: "kept" } },
      { publish: (commit) => published.push(commit) },
    );
    await expect(failed).rejects.toThrow("disk full");
    await expect(next).resolves.toMatchObject({ kind: "recorded", row: { seq: 1 } });
    expect(published.map(({ row }) => row.item)).toEqual([{ type: "user_message", text: "kept" }]);
    expect((await timeline.fetch(root("a"))).rows.map((row) => row.seq)).toEqual([1]);
  });

  it("records a submitted prompt once per client message id", async () => {
    const timeline = createTimeline();
    await timeline.create(root("a"), { epoch: "e" });
    const prompt: AgentTimelineItem = { type: "user_message", text: "Hi", clientMessageId: "c1" };
    const published: number[] = [];
    const publish = ({ row }: TimelineCommit) => published.push(row.seq);
    const first = await timeline.ingest(root("a"), { item: prompt, turnId: "t1" }, { publish });
    const echo = await timeline.ingest(root("a"), { item: prompt }, { publish });
    expect(first).toMatchObject({ kind: "recorded", epoch: "e", row: { seq: 1, turnId: "t1" } });
    expect(echo).toMatchObject({ kind: "duplicate", epoch: "e", row: { seq: 1 } });
    expect(published).toEqual([1]);
    await timeline.attachProviderMessageId(root("a"), "c1", "provider-1");
    expect(await timeline.findSubmittedPrompt(root("a"), "c1")).toMatchObject({
      seq: 1,
      providerMessageId: "provider-1",
    });
  });

  it("keeps a commit whose publication throws and lets later writes proceed", async () => {
    const timeline = createTimeline();
    await timeline.create(root("a"), { epoch: "e" });
    const prompt: AgentTimelineItem = { type: "user_message", text: "Hi", clientMessageId: "c1" };
    const failure = new Error("subscriber failed");
    const throwing = () => {
      throw failure;
    };
    const published: number[] = [];
    const unpublished = timeline.ingest(root("a"), { item: prompt }, { publish: throwing });
    const next = timeline.ingest(
      root("a"),
      { item: { type: "assistant_message", text: "reply" } },
      { publish: ({ row }) => published.push(row.seq) },
    );
    const batch = timeline.append(root("a"), [{ item: { type: "user_message", text: "batch" } }], {
      publish: throwing,
    });
    await expect(unpublished).resolves.toMatchObject({
      kind: "unpublished",
      epoch: "e",
      row: { seq: 1, item: prompt },
      error: failure,
    });
    await expect(next).resolves.toMatchObject({ kind: "recorded", row: { seq: 2 } });
    await expect(batch).resolves.toMatchObject({
      kind: "unpublished",
      commits: [{ row: { seq: 3 } }],
      error: failure,
    });
    expect(published).toEqual([2]);
    // The committed prompt is not recorded twice when ingested again.
    await expect(timeline.ingest(root("a"), { item: prompt })).resolves.toMatchObject({
      kind: "duplicate",
      row: { seq: 1 },
    });
    expect((await timeline.readRows(root("a"))).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("reads the trailing run of assistant messages as the last assistant message", async () => {
    const tool = (callId: string): AgentTimelineItem => ({
      type: "tool_call",
      callId,
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: null, output: null },
    });
    const timeline = createTimeline();
    await timeline.create(root("a"));
    expect(await timeline.lastAssistantMessage(root("a"))).toBeNull();
    await timeline.append(root("a"), [{ item: tool("only") }]);
    expect(await timeline.lastAssistantMessage(root("a"))).toBeNull();
    await timeline.append(root("a"), [
      { item: { type: "assistant_message", text: "Earlier reply" } },
      { item: { type: "user_message", text: "Next" } },
      { item: { type: "assistant_message", text: "Before the tool. " } },
      { item: tool("call-1") },
      { item: { type: "assistant_message", text: "Hel", messageId: "m1" } },
      { item: { type: "assistant_message", text: "lo", messageId: "m1" } },
      { item: { type: "assistant_message", text: " world", messageId: "m2" } },
      { item: tool("call-2") },
    ]);
    expect(await timeline.lastAssistantMessage(root("a"))).toBe("Hello world");
    await timeline.append(root("a"), [
      { item: { type: "user_message", text: "Again" } },
      { item: { type: "assistant_message", text: "Bye" } },
    ]);
    expect(await timeline.lastAssistantMessage(root("a"))).toBe("Bye");
  });

  it("keeps provider child history apart from its parent's", async () => {
    const timeline = createTimeline();
    const child = { agentId: "a", subagentId: "child" };
    await timeline.create(root("a"), { epoch: "parent" });
    await timeline.open(child);
    await append(timeline, "a", { type: "assistant_message", text: "parent" });
    await timeline.append(child, [{ item: { type: "assistant_message", text: "child" } }]);
    expect((await timeline.readRows(child)).map((row) => [row.seq, row.item])).toEqual([
      [1, { type: "assistant_message", text: "child" }],
    ]);
    await timeline.delete(child);
    expect(await timeline.describe(child)).toBeNull();
    expect(await timeline.describe(root("a"))).toEqual({
      epoch: "parent",
      size: 1,
      retirementCount: 0,
      rewind: null,
    });
    await expect(timeline.readRows(child)).rejects.toBeInstanceOf(UnknownTimelineError);
  });

  it("gives a recreated history a new identity", async () => {
    const timeline = createTimeline();
    const before = await timeline.create(root("a"));
    await append(timeline, "a", { type: "user_message", text: "old" });
    const after = await timeline.create(root("a"));
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.size).toBe(0);
    expect(timeline.residentSize(root("a"))).toBe(0);
    expect(await timeline.open(root("a"))).toEqual(after);
  });

  it("bounds ingested content", async () => {
    const timeline = createTimeline();
    await timeline.create(root("a"));
    const text = "a".repeat(400 * 1024);
    const { row } = await timeline.ingest(root("a"), {
      item: { type: "assistant_message", text },
    });
    expect(Buffer.byteLength(JSON.stringify(row.item))).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("history paging", () => {
  it("resets stale forward cursors to complete available turns", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent"), { epoch: "current" });
    for (let index = 0; index < 60; index++)
      await append(
        timeline,
        "agent",
        {
          type: "tool_call",
          callId: `call-${index}`,
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
        { turnId: "run" },
      );
    const page = await timeline.fetch(root("agent"), {
      direction: "after",
      cursor: { epoch: "old", seq: 10 },
      limit: 40,
      wholeTurns: true,
    });
    expect(page.rows).toHaveLength(60);
    expect(page).toMatchObject({
      reset: true,
      staleCursor: true,
      startSeq: 1,
      endSeq: 60,
      hasOlder: false,
      hasNewer: false,
    });
  });

  const seededRows: AgentTimelineRow[] = [
    {
      seq: 5,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: { type: "assistant_message", text: "five", messageId: "five" },
    },
    {
      seq: 6,
      timestamp: "2026-01-01T00:00:01.000Z",
      item: { type: "assistant_message", text: "six", messageId: "six" },
    },
    {
      seq: 7,
      timestamp: "2026-01-01T00:00:02.000Z",
      item: { type: "assistant_message", text: "seven", messageId: "seven" },
    },
  ];

  it("clamps an overshooting before cursor into the bounded tail window", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent-1"), { epoch: "epoch-1", nextSeq: 8, rows: seededRows });

    const result = await timeline.fetch(root("agent-1"), {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent-1"), { epoch: "epoch-1", nextSeq: 8, rows: seededRows });

    const result = await timeline.fetch(root("agent-1"), {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });
});

describe("projected timeline retention", () => {
  it("retains one full tool state while streaming every source update", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent"));
    for (let seq = 1; seq <= 2000; seq++) {
      const item = {
        type: "tool_call" as const,
        callId: "child",
        name: "task",
        status: "running" as const,
        error: null,
        detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
      };
      expect(await append(timeline, "agent", item)).toMatchObject({
        seq,
        item: limitAgentTimelineItemContent(item),
      });
    }
    const result = await timeline.fetch(root("agent"), { limit: 0 });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
    expect(result.window.maxSeq).toBe(2000);
  });

  it("catches up a mid-message cursor with the complete projected message", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent"), { epoch: "e" });
    await append(timeline, "agent", { type: "assistant_message", messageId: "m", text: "A" });
    await append(timeline, "agent", { type: "assistant_message", messageId: "m", text: "B" });
    expect(
      (await timeline.fetch(root("agent"), { direction: "after", cursor: { epoch: "e", seq: 1 } }))
        .rows,
    ).toMatchObject([
      {
        item: { text: "AB" },
        seqStart: 1,
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      },
    ]);
  });

  it("serves a merged assistant message within the item budget", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("agent"), { epoch: "e" });
    const chunk = "a".repeat(200 * 1024);
    for (let index = 0; index < 10; index++) {
      await append(timeline, "agent", { type: "assistant_message", messageId: "m", text: chunk });
    }
    const [row] = (await timeline.fetch(root("agent"), { limit: 1 })).rows;
    expect(row).toMatchObject({ seqStart: 1, seqEnd: 10 });
    expect(row.item).toMatchObject({ type: "assistant_message", messageId: "m" });
    expect(Buffer.byteLength(JSON.stringify(row.item))).toBeLessThanOrEqual(256 * 1024);
    // The resident projection keeps the whole message for completion notifications.
    const [resident] = await timeline.readRows(root("agent"));
    expect(resident.item.type === "assistant_message" && resident.item.text).toHaveLength(
      10 * chunk.length,
    );
  });
});

describe("projected sequence ownership", () => {
  it("preserves fetched coverage when another source chunk arrives", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("a"));
    await append(timeline, "a", { type: "assistant_message", text: "A" });
    const before = await timeline.fetch(root("a"));
    await append(timeline, "a", { type: "assistant_message", text: "B" });
    expect(before.rows[0]).toMatchObject({
      item: { text: "A" },
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    });
    expect((await timeline.fetch(root("a"))).rows[0]).toMatchObject({
      item: { text: "AB" },
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    });
  });

  it("preserves source positions when seeding a projected history whose last update is an earlier tool", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("a"));
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    await append(timeline, "a", { ...tool, status: "running" });
    await append(timeline, "a", { type: "assistant_message", text: "Answer" });
    await append(timeline, "a", { ...tool, status: "completed" });
    await timeline.create(root("b"), { rows: await timeline.readRows(root("a")) });
    expect(await timeline.lastItem(root("b"))).toMatchObject({
      type: "tool_call",
      status: "completed",
    });
    expect((await timeline.readRows(root("b")))[1]?.item).toEqual({
      type: "assistant_message",
      text: "Answer",
    });
    expect((await append(timeline, "b", { type: "user_message", text: "next" })).seq).toBe(4);
    expect(await timeline.lastItem(root("b"))).toEqual({ type: "user_message", text: "next" });
    expect((await timeline.fetch(root("b"))).rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });

  it("keeps differently identified assistant messages as separate rows", async () => {
    const timeline = new AgentTimeline();
    await timeline.create(root("a"));
    await append(timeline, "a", { type: "assistant_message", messageId: "first", text: "First" });
    await append(timeline, "a", { type: "assistant_message", messageId: "second", text: "Sec" });
    await append(timeline, "a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect((await timeline.readRows(root("a"))).map((row) => row.item)).toEqual([
      { type: "assistant_message", messageId: "first", text: "First" },
      { type: "assistant_message", messageId: "second", text: "Second" },
    ]);
  });
});

it("includes transitive tool updates in a contiguous projected tail", async () => {
  const timeline = new AgentTimeline();
  await timeline.create(root("a"));
  const tool = (callId: string, status: "running" | "completed") => ({
    type: "tool_call" as const,
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  });
  await append(timeline, "a", tool("first", "running"));
  await append(timeline, "a", tool("second", "running"));
  await append(timeline, "a", { type: "user_message", text: "Continue" });
  await append(timeline, "a", tool("first", "completed"));
  await append(timeline, "a", { type: "assistant_message", text: "Answer" });
  await append(timeline, "a", tool("second", "completed"));
  const tail = await timeline.fetch(root("a"), { limit: 1 });
  expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 5]);
  expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
});

async function measureTimelineTail(wholeTurns: boolean) {
  const fixture = fileURLToPath(
    new URL("../test-utils/timeline-responsiveness.ts", import.meta.url),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fixture, String(wholeTurns)],
    { timeout: 15_000 },
  );
  process.stderr.write(stderr);
  return JSON.parse(stdout) as {
    result: AgentTimelineFetchResult;
    blockingMs: number;
  };
}

it("excludes unrelated test-runner CPU from the timeline fetch budget", async () => {
  let unrelatedWork: ReturnType<typeof setImmediate>;
  const burnCpu = () => {
    const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
      process,
      "threadCpuUsage",
    );
    const start = threadCpuUsage();
    let elapsed: NodeJS.CpuUsage;
    do {
      elapsed = threadCpuUsage(start);
    } while (elapsed.user + elapsed.system < 80_000);
    unrelatedWork = setImmediate(burnCpu);
  };
  unrelatedWork = setImmediate(burnCpu);
  try {
    const { result: tail, blockingMs } = await measureTimelineTail(false);
    expect(tail.rows).toHaveLength(200);
    expect(tail.startSeq).toBe(99_801);
    expect(tail.endSeq).toBe(100_000);
    expect(blockingMs).toBeLessThan(50);
  } finally {
    clearImmediate(unrelatedWork);
  }
});

it.each([false, true])(
  "serves tail 200 from 100,000 retained rows without stalling the loop (wholeTurns=%s)",
  async (wholeTurns) => {
    const { result: tail, blockingMs } = await measureTimelineTail(wholeTurns);
    expect(tail.rows).toHaveLength(200);
    expect(tail.startSeq).toBe(99_801);
    expect(tail.endSeq).toBe(100_000);
    expect(blockingMs).toBeLessThan(50);
  },
);

it("matches the previous reprojecting selector on seeded randomized timelines", async () => {
  let seed = 0x76aabbcc;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * bound);
  };
  for (let scenario = 0; scenario < 100; scenario++) {
    const timeline = new AgentTimeline();
    await timeline.create(root("a"), { epoch: "e" });
    for (let seq = 1; seq <= 100; seq++) {
      const identity = String(random(8));
      const text = String(seq);
      const items: AgentTimelineItem[] = [
        { type: "user_message", text },
        { type: "assistant_message", text },
        { type: "assistant_message", text, messageId: identity },
        { type: "reasoning", text },
        {
          type: "tool_call",
          callId: identity,
          name: "shell",
          status: "running",
          error: null,
          detail: { type: "plain_text", label: text },
        },
        {
          type: "plugin",
          id: identity,
          pluginId: "test",
          kind: "state",
          version: 1,
          data: { text },
        },
      ];
      await append(timeline, "a", items[random(items.length)], { turnId: String(random(3)) });
    }
    // Include rehydration of already-projected rows, with non-monotonic seqEnd.
    await timeline.create(root("b"), { rows: await timeline.readRows(root("a")), epoch: "e" });
    for (const agentId of ["a", "b"]) {
      await assertSelectionMatchesReference(timeline, agentId);
      await append(timeline, agentId, { type: "assistant_message", text: "later" });
      await assertSelectionMatchesReference(timeline, agentId);
    }
  }
});

async function assertSelectionMatchesReference(
  timeline: AgentTimeline,
  agentId: string,
): Promise<void> {
  const rows = await timeline.readRows(root(agentId));
  for (const direction of ["tail", "before", "after"] as const) {
    for (const limit of [0, 1, 7, 200]) {
      for (const cursorSeq of [0, 1, 25, 50, 99, 100, 150]) {
        const actual = await timeline.fetch(root(agentId), {
          direction,
          limit,
          cursor: { epoch: "e", seq: cursorSeq },
        });
        const expected = selectReferenceProjectedTimelinePage({
          rows,
          bounds: actual.window,
          direction,
          limit,
          cursorSeq,
        });
        expect({
          ...expected,
          entries: undefined,
          rows: expected.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
        }).toEqual({
          entries: undefined,
          rows: actual.rows,
          startSeq: actual.startSeq,
          endSeq: actual.endSeq,
          hasOlder: actual.hasOlder,
          hasNewer: actual.hasNewer,
        });
      }
    }
  }
}

it("continues a scroll across appends and lifecycle collapse without losing source coverage", async () => {
  const timeline = new AgentTimeline();
  await timeline.create(root("a"), { epoch: "e" });
  const tool: AgentTimelineItem = {
    type: "tool_call",
    callId: "t",
    name: "shell",
    status: "running",
    error: null,
    detail: { type: "plain_text", label: "work" },
  };
  await append(timeline, "a", tool);
  for (let seq = 2; seq <= 5; seq++)
    await append(timeline, "a", { type: "user_message", text: String(seq) });
  const first = await timeline.fetch(root("a"), {
    direction: "after",
    cursor: { epoch: "e", seq: 0 },
    limit: 2,
  });
  expect(first.endSeq).toBe(2);
  await append(timeline, "a", { ...tool, status: "completed" });
  await append(timeline, "a", { type: "assistant_message", text: "Done" });
  expect(first.rows[0].item).toMatchObject({ status: "running" });
  const second = await timeline.fetch(root("a"), {
    direction: "after",
    cursor: { epoch: "e", seq: first.endSeq! },
    limit: 2,
  });
  expect(second.rows.map((row) => row.seqStart)).toEqual([3, 4]);
  expect(second.endSeq).toBe(4);
  const third = await timeline.fetch(root("a"), {
    direction: "after",
    cursor: { epoch: "e", seq: second.endSeq! },
    limit: 2,
  });
  expect(third.rows.map((row) => row.seqStart)).toEqual([1, 5]);
  expect(third.rows[0].item).toMatchObject({ status: "completed" });
  expect(third.endSeq).toBe(6);
  const last = await timeline.fetch(root("a"), {
    direction: "after",
    cursor: { epoch: "e", seq: third.endSeq! },
    limit: 2,
  });
  expect(last.rows.map((row) => row.item)).toEqual([{ type: "assistant_message", text: "Done" }]);
  expect(last.endSeq).toBe(7);
  expect(last.hasNewer).toBe(false);
});

describe("conversation rewind", () => {
  const scope = root("agent");
  const createBackend = () => new DeferredTimelineBackend();

  function prompt(messageId: string, turnId: string): TimelineEntry {
    return { item: { type: "user_message", text: messageId, messageId }, turnId };
  }

  function reply(text: string, turnId: string): TimelineEntry {
    return { item: { type: "assistant_message", text, messageId: `reply-${text}` }, turnId };
  }

  function tool(callId: string, turnId: string, status: "running" | "completed"): TimelineEntry {
    return {
      item: {
        type: "tool_call",
        callId,
        name: "shell",
        status,
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
      turnId,
    };
  }

  async function conversation(): Promise<{
    backend: DeferredTimelineBackend;
    timeline: AgentTimeline;
  }> {
    const backend = createBackend();
    const timeline = new AgentTimeline(backend);
    await timeline.create(scope, { epoch: "e" });
    await timeline.append(scope, [
      prompt("a", "t1"),
      reply("A", "t1"),
      prompt("b", "t2"),
      tool("call-b", "t2", "running"),
      reply("B", "t2"),
    ]);
    return { backend, timeline };
  }

  async function rewind(
    timeline: AgentTimeline,
    messageId: string,
    cut: ConversationRewindCut = { kind: "at_target" },
  ): Promise<TimelineRewindCompletion> {
    const intent = await timeline.beginRewind(scope, messageId);
    await timeline.recordRewindCut(scope, intent.id, cut);
    return timeline.completeRewind(scope, intent.id);
  }

  function texts(rows: readonly { item: AgentTimelineItem }[]): string[] {
    return rows.map((row) => ("text" in row.item ? row.item.text : row.item.type));
  }

  it("retires the rewound turn from active history and keeps it stored", async () => {
    const { backend, timeline } = await conversation();
    const published: TimelineRetirementCommit[] = [];
    const intent = await timeline.beginRewind(scope, "b");
    await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" });
    const completion = await timeline.completeRewind(scope, intent.id, {
      publish: (commit) => published.push(commit),
    });
    await timeline.append(scope, [prompt("c", "t3"), reply("C", "t3")]);

    expect(completion).toMatchObject({
      kind: "retired",
      retirement: { seq: 6, retireFromSeq: 3 },
      epoch: "e",
      retirementCount: 1,
    });
    expect(published.map((commit) => texts(commit.retiredRows))).toEqual([["b", "tool_call", "B"]]);
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "c", "C"]);
    expect(texts(backend.retiredRows(scope))).toEqual(["b", "tool_call", "B"]);
    expect(await timeline.describe(scope)).toEqual({
      epoch: "e",
      size: 4,
      retirementCount: 1,
      rewind: null,
    });
    const tail = await timeline.fetch(scope);
    expect(texts(tail.rows)).toEqual(["a", "A", "c", "C"]);
    expect(tail).toMatchObject({
      epoch: "e",
      startSeq: 1,
      endSeq: 8,
      retirements: [{ seq: 6, retireFromSeq: 3 }],
    });
  });

  it("advances a caught-up cursor through the retirement to the next turn", async () => {
    const { timeline } = await conversation();
    await rewind(timeline, "b");
    await timeline.append(scope, [prompt("c", "t3"), reply("C", "t3")]);

    const catchUp = await timeline.fetch(scope, {
      direction: "after",
      cursor: { epoch: "e", seq: 5 },
    });
    expect(texts(catchUp.rows)).toEqual(["c", "C"]);
    expect(catchUp).toMatchObject({
      reset: false,
      startSeq: 6,
      endSeq: 8,
      hasNewer: false,
      retirements: [{ seq: 6, retireFromSeq: 3 }],
    });

    const retirementOnly = await timeline.fetch(scope, {
      direction: "after",
      cursor: { epoch: "e", seq: 5 },
      limit: 1,
    });
    expect(retirementOnly).toMatchObject({
      rows: [],
      startSeq: 6,
      endSeq: 6,
      hasNewer: true,
      retirements: [{ seq: 6, retireFromSeq: 3 }],
    });
    const next = await timeline.fetch(scope, {
      direction: "after",
      cursor: { epoch: "e", seq: 6 },
    });
    expect(texts(next.rows)).toEqual(["c", "C"]);
    expect(next.retirements).toEqual([]);
  });

  it("pages a tail whose last turn was rewound with nothing after it", async () => {
    const { timeline } = await conversation();
    await rewind(timeline, "b");

    const tail = await timeline.fetch(scope);
    expect(texts(tail.rows)).toEqual(["a", "A"]);
    expect(tail).toMatchObject({ endSeq: 6, retirements: [{ seq: 6, retireFromSeq: 3 }] });
    const caughtUp = await timeline.fetch(scope, {
      direction: "after",
      cursor: { epoch: "e", seq: 2 },
    });
    expect(caughtUp).toMatchObject({
      rows: [],
      endSeq: 6,
      hasNewer: false,
      retirements: [{ seq: 6, retireFromSeq: 3 }],
    });
  });

  it("cannot retire a later turn by completing the same rewind again", async () => {
    const { timeline } = await conversation();
    const intent = await timeline.beginRewind(scope, "b");
    await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" });
    await timeline.completeRewind(scope, intent.id);
    await timeline.append(scope, [prompt("c", "t3"), reply("C", "t3")]);

    expect(await timeline.completeRewind(scope, intent.id)).toEqual({ kind: "absent" });
    expect(await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" })).toBeNull();
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "c", "C"]);
    expect((await timeline.describe(scope))?.retirementCount).toBe(1);
  });

  it("drops late output of a retired turn and still accepts updates to active items", async () => {
    const timeline = new AgentTimeline(createBackend());
    await timeline.create(scope, { epoch: "e" });
    await timeline.append(scope, [
      prompt("a", "t1"),
      tool("call-a", "t1", "running"),
      prompt("b", "t2"),
      tool("call-b", "t2", "running"),
    ]);
    await rewind(timeline, "b");

    const late = await timeline.ingest(scope, tool("call-b", "t2", "completed"));
    const lateText = await timeline.ingest(scope, reply("B again", "t2"));
    const reusedCallId = await timeline.ingest(scope, tool("call-a", "t2", "completed"));
    const active = await timeline.ingest(scope, tool("call-a", "t1", "completed"));

    expect([late, lateText, reusedCallId].map((result) => result.kind)).toEqual([
      "dropped",
      "dropped",
      "dropped",
    ]);
    expect(active.kind).toBe("recorded");
    const rows = await timeline.readRows(scope);
    expect(rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "a", messageId: "a" },
      expect.objectContaining({ type: "tool_call", callId: "call-a", status: "completed" }),
    ]);
  });

  it("allows one open rewind at a time and leaves history alone when abandoned", async () => {
    const { timeline } = await conversation();
    const intent = await timeline.beginRewind(scope, "b");

    await expect(timeline.beginRewind(scope, "a")).rejects.toBeInstanceOf(
      TimelineRewindPendingError,
    );
    await expect(timeline.completeRewind(scope, intent.id)).rejects.toThrow(
      "Cannot complete a rewind before its provider outcome",
    );
    await timeline.abandonRewind(scope, intent.id);
    expect((await timeline.describe(scope))?.rewind).toBeNull();
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "tool_call", "B"]);
    await expect(timeline.beginRewind(scope, "missing")).rejects.toBeInstanceOf(
      TimelineRewindTargetError,
    );
    expect((await timeline.beginRewind(scope, "a")).targetSeq).toBe(1);
  });

  it("retires from the boundary the provider actually kept", async () => {
    const { timeline } = await conversation();
    await timeline.append(scope, [prompt("c", "t3"), reply("C", "t3")]);

    const completion = await rewind(timeline, "c", { kind: "after", retainedMessageId: "a" });

    expect(completion).toMatchObject({ kind: "retired", retirement: { retireFromSeq: 3 } });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A"]);
  });

  it("matches the retained boundary by the provider's message id", async () => {
    const backend = createBackend();
    const timeline = new AgentTimeline(backend);
    await timeline.create(scope, { epoch: "e" });
    await timeline.ingest(scope, {
      item: { type: "user_message", text: "a", messageId: "a", clientMessageId: "client-a" },
    });
    await timeline.attachProviderMessageId(scope, "client-a", "provider-a");
    await timeline.append(scope, [reply("A", "t1"), prompt("b", "t2"), prompt("c", "t3")]);

    await rewind(timeline, "c", { kind: "after", retainedMessageId: "provider-a" });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A"]);

    await rewind(timeline, "a", { kind: "after", retainedMessageId: null });
    expect(await timeline.readRows(scope)).toEqual([]);
  });

  it("keeps the rewind open when the provider's boundary is after the target", async () => {
    const { timeline } = await conversation();
    const intent = await timeline.beginRewind(scope, "a");
    await timeline.recordRewindCut(scope, intent.id, { kind: "after", retainedMessageId: "a" });

    await expect(timeline.completeRewind(scope, intent.id)).rejects.toBeInstanceOf(
      TimelineRewindBoundaryError,
    );
    expect((await timeline.describe(scope))?.rewind).toMatchObject({ id: intent.id });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "tool_call", "B"]);
  });

  it("keeps active history and the open rewind when the retirement fails to commit", async () => {
    const { backend, timeline } = await conversation();
    const intent = await timeline.beginRewind(scope, "b");
    await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" });
    backend.failNextRetire = true;

    await expect(timeline.completeRewind(scope, intent.id)).rejects.toThrow("disk full");
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "tool_call", "B"]);
    expect(await timeline.describe(scope)).toMatchObject({ retirementCount: 0 });

    expect(await timeline.completeRewind(scope, intent.id)).toMatchObject({
      kind: "retired",
      retirement: { seq: 6, retireFromSeq: 3 },
    });
  });

  it("judges an unsettled rewind from the provider's own history", async () => {
    const { timeline } = await conversation();
    await timeline.append(scope, [prompt("c", "t3"), reply("C", "t3")]);
    const intent = await timeline.beginRewind(scope, "b");

    expect(await timeline.judgeRewind(scope, intent.id, ["a", "b", "c"])).toEqual({
      kind: "unchanged",
    });
    expect(await timeline.judgeRewind(scope, intent.id, ["a"])).toEqual({
      kind: "applied",
      cut: { kind: "after", retainedMessageId: "a" },
    });
    expect(await timeline.judgeRewind(scope, intent.id, ["a", "b"])).toMatchObject({
      kind: "unknown",
      reason: "The provider history ends after the rewind target",
    });
    expect(await timeline.judgeRewind(scope, intent.id, ["a", "x"])).toMatchObject({
      kind: "unknown",
      reason: "The provider history differs from Paseo's",
    });
    expect(await timeline.judgeRewind(scope, intent.id, [])).toMatchObject({
      kind: "unknown",
      reason: "The provider history has no prompts",
    });
    expect(await timeline.judgeRewind(scope, "other", ["a"])).toEqual({ kind: "absent" });
    expect(texts(await timeline.readRows(scope))).toEqual([
      "a",
      "A",
      "b",
      "tool_call",
      "B",
      "c",
      "C",
    ]);
    expect((await timeline.describe(scope))?.rewind).toMatchObject({ id: intent.id });
  });

  it("judges against provider ids and skips prompts the provider never acknowledged", async () => {
    const timeline = new AgentTimeline(createBackend());
    await timeline.create(scope, { epoch: "e" });
    for (const id of ["a", "b", "c"]) {
      await timeline.ingest(scope, {
        item: { type: "user_message", text: id, messageId: id, clientMessageId: id },
      });
      if (id !== "b") await timeline.attachProviderMessageId(scope, id, `provider-${id}`);
    }
    const intent = await timeline.beginRewind(scope, "c");

    expect(await timeline.judgeRewind(scope, intent.id, ["provider-a", "provider-c"])).toEqual({
      kind: "unchanged",
    });
    const verdict = await timeline.judgeRewind(scope, intent.id, ["provider-a"]);
    expect(verdict).toEqual({
      kind: "applied",
      cut: { kind: "after", retainedMessageId: "provider-a" },
    });
    if (verdict.kind !== "applied") throw new Error("expected an applied verdict");
    await timeline.recordRewindCut(scope, intent.id, verdict.cut);
    await timeline.completeRewind(scope, intent.id);
    expect(texts(await timeline.readRows(scope))).toEqual(["a"]);
  });

  it("bounds pages across a thousand rewinds", async () => {
    const backend = createBackend();
    const timeline = new AgentTimeline(backend);
    await timeline.create(scope, { epoch: "e" });
    await timeline.append(scope, [prompt("kept", "t0"), reply("kept", "t0")]);
    for (let index = 0; index < 1000; index++) {
      await timeline.append(scope, [prompt(`p${index}`, `t${index + 1}`)]);
      await rewind(timeline, `p${index}`);
    }

    const tail = await timeline.fetch(scope, { limit: 50 });
    expect(texts(tail.rows)).toEqual(["kept", "kept"]);
    expect(tail.retirements).toEqual([{ seq: 2002, retireFromSeq: 3 }]);

    let cursor = 2;
    let pages = 0;
    for (;;) {
      const page = await timeline.fetch(scope, {
        direction: "after",
        cursor: { epoch: "e", seq: cursor },
        limit: 50,
      });
      pages += 1;
      expect(page.rows).toEqual([]);
      expect(page.retirements.length).toBe(1);
      if (page.endSeq === null) throw new Error("after-page lost its cursor");
      cursor = page.endSeq;
      if (!page.hasNewer) break;
    }
    expect(cursor).toBe(2002);
    // Each page covers 50 prompts and their 50 retirements.
    expect(pages).toBe(20);
  });
});

describe("provider history", () => {
  const scope = root("agent");

  function prompt(messageId: string): TimelineEntry {
    return { item: { type: "user_message", text: messageId, messageId } };
  }

  function submitted(clientMessageId: string): TimelineEntry {
    return {
      item: {
        type: "user_message",
        text: clientMessageId,
        messageId: clientMessageId,
        clientMessageId,
      },
    };
  }

  function reply(text: string): TimelineEntry {
    return { item: { type: "assistant_message", text } };
  }

  function texts(rows: readonly { item: AgentTimelineItem }[]): string[] {
    return rows.map((row) => ("text" in row.item ? row.item.text : row.item.type));
  }

  function committedTexts(commits: readonly { row: { item: AgentTimelineItem } }[]): string[] {
    return texts(commits.map((commit) => commit.row));
  }

  async function owned(entries: TimelineEntry[]): Promise<{
    backend: DeferredTimelineBackend;
    timeline: AgentTimeline;
  }> {
    const backend = new DeferredTimelineBackend();
    const timeline = new AgentTimeline(backend);
    await timeline.create(scope, { epoch: "e" });
    await timeline.append(scope, entries);
    return { backend, timeline };
  }

  it("imports history into a scope that has none, once", async () => {
    const timeline = new AgentTimeline(new DeferredTimelineBackend());
    const history = [prompt("a"), reply("A"), prompt("b"), reply("B")];

    const first = await timeline.importHistory(scope, history);
    const repeat = await timeline.importHistory(scope, history);

    expect(first).toMatchObject({ kind: "imported", head: { size: 4, retirementCount: 0 } });
    expect(repeat).toEqual({ kind: "present", head: first.head });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "B"]);
    const tail = await timeline.fetch(scope);
    expect(tail).toMatchObject({ epoch: first.head.epoch, startSeq: 1, endSeq: 4 });
  });

  it("leaves existing history alone when asked to import", async () => {
    const { timeline } = await owned([prompt("a"), reply("A")]);

    const result = await timeline.importHistory(scope, [prompt("x"), reply("X")]);

    expect(result).toMatchObject({ kind: "present", head: { epoch: "e", size: 2 } });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A"]);
  });

  function tool(callId: string, output: string, status: "running" | "completed" = "completed") {
    const detail = { type: "shell" as const, command: "npm test", output };
    const item: AgentTimelineItem =
      status === "running"
        ? { type: "tool_call", callId, name: "shell", status, error: null, detail }
        : { type: "tool_call", callId, name: "shell", status, error: null, detail };
    return { item };
  }

  it("changes nothing when the provider holds the same conversation", async () => {
    const { backend, timeline } = await owned([
      prompt("a"),
      tool("t1", "3 passed"),
      reply("Tests "),
      reply("pass."),
      // Paseo writes notifications itself; the provider has none.
      { item: { type: "notification", level: "info", message: "Agent resumed" } },
      prompt("b"),
      reply("B"),
    ]);
    const appendsBefore = backend.appends.length;
    const published: unknown[] = [];

    const result = await timeline.reconcileProviderHistory(
      scope,
      [
        prompt("a"),
        // The same tool call, its fields in another order.
        {
          item: {
            detail: { output: "3 passed", command: "npm test", type: "shell" },
            error: null,
            status: "completed",
            name: "shell",
            callId: "t1",
            type: "tool_call",
          },
        },
        // The provider stores the answer whole; Paseo streamed it in chunks.
        reply("Tests pass."),
        prompt("b"),
        reply("B"),
      ],
      { publish: (commits) => published.push(commits) },
    );

    expect(result).toEqual({ kind: "unchanged" });
    expect(published).toEqual([]);
    expect(backend.appends.length).toBe(appendsBefore);
    expect(await timeline.describe(scope)).toMatchObject({ epoch: "e", retirementCount: 0 });
  });

  it("appends the turns the provider has after the owned conversation", async () => {
    const { timeline } = await owned([prompt("a"), reply("A")]);
    const published: TimelineCommit[][] = [];

    const result = await timeline.reconcileProviderHistory(
      scope,
      [prompt("a"), reply("A"), prompt("b"), reply("B")],
      { publish: (commits) => published.push(commits) },
    );

    expect(result).toMatchObject({ kind: "appended" });
    expect(published.map(committedTexts)).toEqual([["b", "B"]]);
    expect(published[0].map((commit) => commit.row.seq)).toEqual([3, 4]);
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "B"]);
    expect(await timeline.describe(scope)).toMatchObject({ epoch: "e", retirementCount: 0 });
  });

  it.each([
    {
      case: "the turn has no output yet",
      owned: [prompt("a"), reply("A"), prompt("b")],
      appended: ["tool_call", "B"],
    },
    {
      case: "the turn ends on a finished tool call",
      owned: [prompt("a"), reply("A"), prompt("b"), tool("t1", "3 passed")],
      appended: ["B"],
    },
  ])("appends the rows the provider has after the last turn when $case", async (example) => {
    const { timeline } = await owned(example.owned);
    const before = await timeline.readRows(scope);

    const result = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      reply("A"),
      prompt("b"),
      tool("t1", "3 passed"),
      reply("B"),
    ]);

    expect(result).toMatchObject({ kind: "appended" });
    if (result.kind !== "appended") throw new Error("expected an append");
    expect(committedTexts(result.commits)).toEqual(example.appended);
    // The rows Paseo already showed are the same rows, unchanged.
    expect((await timeline.readRows(scope)).slice(0, before.length)).toEqual(before);
    expect(await timeline.describe(scope)).toMatchObject({ epoch: "e", retirementCount: 0 });
  });

  it.each([
    {
      case: "an earlier answer differs under the same prompts",
      provider: [prompt("a"), reply("edited"), prompt("b"), reply("B"), prompt("c"), reply("C")],
      reason: "The provider history has a different answer",
    },
    {
      case: "the last answer differs under the same prompts",
      provider: [prompt("a"), reply("A"), prompt("b"), reply("something else"), prompt("c")],
      reason: "The provider history has a different last answer",
    },
    {
      case: "the provider's last answer is shorter than Paseo's",
      provider: [prompt("a"), reply("A"), prompt("b"), reply("B"), prompt("c")],
      owned: [prompt("a"), reply("A"), prompt("b"), reply("B and more")],
      reason: "The provider history has a different last answer",
    },
    {
      case: "the provider finished an answer Paseo saw only part of",
      owned: [prompt("a"), reply("A"), prompt("b"), reply("The answer is")],
      provider: [prompt("a"), reply("A"), prompt("b"), reply("The answer is 42."), prompt("c")],
      reason: "The provider history has a different last answer",
    },
    {
      case: "a tool call Paseo saw running has finished",
      owned: [prompt("a"), reply("A"), prompt("b"), tool("t1", "", "running")],
      provider: [prompt("a"), reply("A"), prompt("b"), tool("t1", "3 passed"), reply("B")],
      reason: "The provider history has a different last answer",
    },
    {
      case: "only the indentation of an answer differs",
      owned: [prompt("a"), reply("def f():\n    return 1"), prompt("b"), reply("B")],
      provider: [prompt("a"), reply("def f():\n  return 1"), prompt("b"), reply("B")],
      reason: "The provider history has a different answer",
    },
    {
      case: "only the spacing inside a string differs",
      owned: [prompt("a"), reply("A"), prompt("b"), reply('print("a  b")')],
      provider: [prompt("a"), reply("A"), prompt("b"), reply('print("a b")'), prompt("c")],
      reason: "The provider history has a different last answer",
    },
    {
      case: "the answer is the same but a tool result differs",
      owned: [prompt("a"), tool("t1", "3 passed"), reply("Done"), prompt("b"), reply("B")],
      provider: [prompt("a"), tool("t1", "1 failed"), reply("Done"), prompt("b"), reply("B")],
      reason: "The provider history has a different answer",
    },
    {
      case: "the prompts differ",
      provider: [prompt("a"), reply("A"), prompt("x"), reply("B"), prompt("c")],
      reason: "The provider history has different prompts",
    },
    {
      case: "the provider dropped a turn Paseo shows",
      provider: [prompt("a"), reply("A")],
      reason: "The provider history is missing turns Paseo shows",
    },
  ])("keeps the owned history when $case", async (example) => {
    const { backend, timeline } = await owned(
      example.owned ?? [prompt("a"), reply("A"), prompt("b"), reply("B")],
    );
    const before = await timeline.readRows(scope);
    const appendsBefore = backend.appends.length;

    const result = await timeline.reconcileProviderHistory(scope, example.provider);

    expect(result).toEqual({ kind: "diverged", reason: example.reason });
    expect(await timeline.readRows(scope)).toEqual(before);
    expect(backend.appends.length).toBe(appendsBefore);
    expect(await timeline.describe(scope)).toMatchObject({ epoch: "e", retirementCount: 0 });
  });

  function promptText(messageId: string, text: string): TimelineEntry {
    return { item: { type: "user_message", text, messageId } };
  }

  it.each([
    {
      case: "an earlier prompt was edited under the same id",
      provider: [promptText("a", "a, edited"), reply("A"), prompt("b"), reply("B"), prompt("c")],
    },
    {
      case: "the last prompt was edited under the same id",
      provider: [prompt("a"), reply("A"), promptText("b", "b, edited"), reply("B"), prompt("c")],
    },
    {
      case: "only the spacing inside a prompt differs",
      owned: [promptText("a", "fix  it"), reply("A"), prompt("b"), reply("B")],
      provider: [promptText("a", "fix it"), reply("A"), prompt("b"), reply("B")],
    },
    {
      case: "only a prompt's trailing whitespace differs",
      provider: [promptText("a", "a "), reply("A"), prompt("b"), reply("B")],
    },
  ])("keeps the owned history when $case", async (example) => {
    const { backend, timeline } = await owned(
      example.owned ?? [prompt("a"), reply("A"), prompt("b"), reply("B")],
    );
    const before = await timeline.readRows(scope);
    const appendsBefore = backend.appends.length;

    const result = await timeline.reconcileProviderHistory(scope, example.provider);

    expect(result).toEqual({
      kind: "diverged",
      reason: "The provider history has different prompts",
    });
    expect(await timeline.readRows(scope)).toEqual(before);
    expect(backend.appends.length).toBe(appendsBefore);
  });

  it("matches a prompt Paseo submitted to the provider's stored copy of it", async () => {
    const typed = "Fix the login bug.\n\n  Keep the API as it is.";
    const { timeline } = await owned([
      { item: { type: "user_message", text: typed, messageId: "c-1", clientMessageId: "c-1" } },
    ]);
    await timeline.attachProviderMessageId(scope, "c-1", "p-1");
    await timeline.append(scope, [reply("Done.")]);

    const result = await timeline.reconcileProviderHistory(scope, [
      promptText("p-1", typed),
      reply("Done."),
      prompt("b"),
      reply("B"),
    ]);

    expect(result).toMatchObject({ kind: "appended" });
    expect(texts(await timeline.readRows(scope))).toEqual([typed, "Done.", "b", "B"]);
  });

  it("reads a prompt the provider repeats unchanged as one turn", async () => {
    const { timeline } = await owned([prompt("a"), reply("A")]);

    const result = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      prompt("a"),
      reply("A"),
    ]);

    expect(result).toEqual({ kind: "unchanged" });
  });

  it("keeps the owned history when the provider repeats a prompt id with other text", async () => {
    const { backend, timeline } = await owned([prompt("a")]);
    const appendsBefore = backend.appends.length;

    const result = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      promptText("a", "something else"),
      reply("A"),
    ]);

    expect(result).toEqual({
      kind: "diverged",
      reason: "The provider history has two prompts with one id",
    });
    expect(texts(await timeline.readRows(scope))).toEqual(["a"]);
    expect(backend.appends.length).toBe(appendsBefore);
  });

  it("does not append provider turns after a prompt the provider never received", async () => {
    const { timeline } = await owned([prompt("a"), reply("A"), submitted("refused")]);

    const result = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      reply("A"),
      prompt("b"),
      reply("B"),
    ]);

    expect(result).toEqual({
      kind: "diverged",
      reason: "A prompt the provider did not receive is last",
    });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "refused"]);
  });

  it("keeps a rewound turn retired while appending what the provider added after it", async () => {
    const { timeline } = await owned([prompt("a"), reply("A"), prompt("b"), reply("B")]);
    const intent = await timeline.beginRewind(scope, "b");
    await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" });
    await timeline.completeRewind(scope, intent.id);
    await timeline.append(scope, [prompt("c"), reply("C")]);

    const stale = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      reply("A"),
      prompt("b"),
      reply("B"),
      prompt("c"),
      reply("C"),
    ]);
    const continued = await timeline.reconcileProviderHistory(scope, [
      prompt("a"),
      reply("A"),
      prompt("c"),
      reply("C"),
      prompt("d"),
      reply("D"),
    ]);

    expect(stale).toEqual({
      kind: "diverged",
      reason: "The provider history has different prompts",
    });
    expect(continued).toMatchObject({ kind: "appended" });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "c", "C", "d", "D"]);
    expect(await timeline.describe(scope)).toMatchObject({ epoch: "e", retirementCount: 1 });
  });

  it("leaves history alone while a rewind is open", async () => {
    const { timeline } = await owned([prompt("a"), reply("A"), prompt("b"), reply("B")]);
    await timeline.beginRewind(scope, "b");

    const result = await timeline.reconcileProviderHistory(scope, [prompt("a"), reply("A")]);

    expect(result).toEqual({ kind: "rewind_open" });
    expect(texts(await timeline.readRows(scope))).toEqual(["a", "A", "b", "B"]);
  });
});
