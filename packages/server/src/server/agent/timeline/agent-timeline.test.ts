import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import type { AgentTimelineFetchResult, AgentTimelineRow } from "../agent-timeline-store-types.js";
import { DeferredTimelineBackend } from "./testing.js";
import { selectReferenceProjectedTimelinePage } from "../test-utils/timeline-page-reference.js";
import { AgentTimeline, type TimelineCommit, type TimelineScope } from "./index.js";
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
    expect(await timeline.describe(root("a"))).toEqual({ epoch: "parent", size: 1 });
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
