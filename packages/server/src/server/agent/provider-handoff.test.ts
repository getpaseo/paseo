import { expect, test } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  buildCompactionPrompt,
  buildHandoffText,
  chunkRecords,
  handoffLimitTokens,
  planProviderHandoff,
  withProviderHandoff,
  type HandoffRow,
} from "./provider-handoff.js";

function rows(items: AgentTimelineItem[], firstSeq = 1): HandoffRow[] {
  return items.map((item, index) => ({ seq: firstSeq + index, item }));
}

function messages(count: number, size: number): HandoffRow[] {
  return rows(
    Array.from({ length: count }, (_, index) => ({
      type: "user_message" as const,
      text: `record-${index}:` + "x".repeat(size),
    })),
  );
}

const PROVIDER_WORDS = /provider|codex|claude|opencode|previous agent|another model|switch/i;

test("handoff includes messages and tool evidence without replaying private reasoning", () => {
  const plan = planProviderHandoff({
    rows: rows([
      { type: "user_message", text: "Fix the build" },
      { type: "reasoning", text: "private reasoning" },
      {
        type: "tool_call",
        callId: "build",
        name: "exec_command",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", output: "all tests passed", exitCode: 0 },
      },
      { type: "assistant_message", text: "The build works" },
    ]),
  });
  expect(plan.kind).toBe("full");
  if (plan.kind !== "full") return;
  expect(plan.text).toContain("Fix the build");
  expect(plan.text).toContain("all tests passed");
  expect(plan.text).not.toContain("private reasoning");
  expect(plan.records).toBe(3);
});

test("the model is not told that the chat changed providers", () => {
  const history = rows([
    { type: "user_message", text: "Fix the build" },
    {
      type: "tool_call",
      callId: "build",
      name: "exec_command",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "npm test", output: "ok", exitCode: 0 },
    },
    {
      type: "tool_call",
      callId: "custom",
      name: "mcp__paseo__list_agents",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: {}, output: "[]" },
    },
  ]);
  const fresh = planProviderHandoff({ rows: history });
  const back = planProviderHandoff({
    rows: history,
    afterSeq: 0,
    intro: "return",
    base: { summary: "Earlier work.", throughSeq: 1, origin: "codex's own compaction" },
  });
  if (fresh.kind !== "full" || back.kind !== "full") throw new Error("expected full plans");
  for (const text of [fresh.text, back.text]) {
    const [lead] = text.split("\n{");
    expect(lead).not.toMatch(PROVIDER_WORDS);
    // A normalized tool keeps its detail and drops the provider's tool name.
    expect(text).not.toContain("exec_command");
  }
  // A tool without a normalized detail keeps its name, which is all that says what it did.
  expect(fresh.text).toContain("mcp__paseo__list_agents");
  expect(back.text).not.toContain("codex's own compaction");
  expect(buildCompactionPrompt({ context: "", chunk: "{}", part: 1, parts: 1 })).not.toMatch(
    /another model|provider/i,
  );
});

test("a history that fits the window goes across whole, however long", () => {
  // About 1 200 000 characters (600 000 estimated tokens): far above the earlier fixed cap, inside
  // a 1 000 000-token window.
  const plan = planProviderHandoff({ rows: messages(300, 4_000), contextWindowTokens: 1_000_000 });
  expect(plan.kind).toBe("full");
  if (plan.kind !== "full") return;
  expect(plan.records).toBe(300);
  expect(plan.text).toContain("record-0:");
  expect(plan.text).toContain("record-299:");
  expect(plan.text).not.toContain("summarized");
});

test("an empty history needs no handoff", () => {
  const plan = planProviderHandoff({
    rows: rows([{ type: "reasoning", text: "only private reasoning" }]),
  });
  expect(plan).toMatchObject({ kind: "full", text: "", records: 0 });
});

test("a history over the window is compacted oldest first and keeps the newest records whole", () => {
  // 40 000 tokens leave 8 000 tokens: 16 000 characters for the handoff at 2 characters per token.
  expect(handoffLimitTokens(40_000)).toBe(8_000);
  const plan = planProviderHandoff({ rows: messages(30, 2_000), contextWindowTokens: 40_000 });
  expect(plan.kind).toBe("compact");
  if (plan.kind !== "compact") return;
  // The newest records fill up to half the limit (8 000 characters) and are contiguous.
  expect(plan.recentRecords.length).toBeGreaterThan(0);
  expect(plan.recentRecords.at(-1)).toContain("record-29:");
  expect(plan.olderRecords + plan.recentRecords.length).toBe(30);
  expect(plan.recentRecords.join("\n").length).toBeLessThanOrEqual(8_000);
  // The summary covers the older records, through the last older row.
  expect(plan.olderThroughSeq).toBe(plan.olderRecords);
  // Every older record is in exactly one chunk, oldest first, and each chunk fits a summarizer call.
  const older = plan.olderChunks.join("\n");
  for (let index = 0; index < plan.olderRecords; index += 1) {
    expect(older).toContain(`record-${index}:`);
  }
  expect(older).not.toContain(`record-${plan.olderRecords}:`);
  expect(plan.olderChunks[0]).toContain("record-0:");
  // 60 % of the limit: 4 800 tokens, 9 600 characters.
  for (const chunk of plan.olderChunks) expect(chunk.length).toBeLessThanOrEqual(9_600);
});

test("a summary that already covers the oldest rows replaces them", () => {
  const plan = planProviderHandoff({
    rows: messages(10, 100),
    base: { summary: "Records 0 to 5 in short.", throughSeq: 6, origin: "claude's own compaction" },
  });
  expect(plan.kind).toBe("full");
  if (plan.kind !== "full") return;
  expect(plan.base?.throughSeq).toBe(6);
  expect(plan.records).toBe(4);
  expect(plan.text).toContain("Records 0 to 5 in short.");
  expect(plan.text).not.toContain("record-5:");
  expect(plan.text).toContain("record-6:");
  expect(plan.text).toContain("record-9:");
});

test("switching back sends only what happened after the provider left", () => {
  const plan = planProviderHandoff({ rows: messages(10, 100), afterSeq: 7, intro: "return" });
  expect(plan.kind).toBe("full");
  if (plan.kind !== "full") return;
  expect(plan.records).toBe(3);
  expect(plan.text).not.toContain("record-6:");
  expect(plan.text).toContain("record-7:");
  expect(plan.text).toContain("continued after your last reply");
});

test("a summary older than the return point is not sent back", () => {
  const plan = planProviderHandoff({
    rows: messages(10, 100),
    afterSeq: 7,
    intro: "return",
    base: { summary: "Old summary.", throughSeq: 5, origin: "an earlier switch" },
  });
  if (plan.kind !== "full") throw new Error("expected a full plan");
  expect(plan.base).toBeUndefined();
  expect(plan.text).not.toContain("Old summary.");
});

test("a compaction continues from the summary that already covers the oldest rows", () => {
  const plan = planProviderHandoff({
    rows: messages(30, 2_000),
    contextWindowTokens: 40_000,
    base: { summary: "First ten.", throughSeq: 10, origin: "an earlier switch" },
  });
  expect(plan.kind).toBe("compact");
  if (plan.kind !== "compact") return;
  expect(plan.base?.summary).toBe("First ten.");
  expect(plan.olderChunks.join("\n")).not.toContain("record-9:");
  expect(plan.olderChunks[0]).toContain("record-10:");
});

test("a record larger than a chunk is cut into pieces instead of being dropped", () => {
  const big = "y".repeat(25_000);
  const chunks = chunkRecords(["small-a", big, "small-b"], 10_000);
  expect(chunks).toEqual([
    "small-a",
    big.slice(0, 10_000),
    big.slice(10_000, 20_000),
    big.slice(20_000),
    "small-b",
  ]);
});

test("the compacted handoff carries the summary and then the newest records", () => {
  const text = buildHandoffText({
    intro: "new",
    summary: "The user wants the migration kept compatible.",
    records: ['{"role":"user","text":"newest"}'],
  });
  expect(text).toContain("The user wants the migration kept compatible.");
  expect(text.indexOf("migration kept compatible")).toBeLessThan(text.indexOf('"newest"'));
});

test("handoff preserves structured image attachments on the new message", () => {
  const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
  expect(
    withProviderHandoff([image, { type: "text", text: "Inspect this" }], "previous task"),
  ).toEqual([
    { type: "text", text: expect.stringContaining("previous task") },
    image,
    { type: "text", text: "Inspect this" },
  ]);
});
