import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function row(seq: number, text: string, extra?: Partial<AgentTimelineRow>): AgentTimelineRow {
  return {
    seq,
    timestamp: TIMESTAMP,
    item: { type: "user_message", text, clientMessageId: `c${seq}` },
    ...extra,
  };
}

describe("FileAgentTimelineStore", () => {
  let directory: string;
  let store: FileAgentTimelineStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "paseo-timeline-rows-"));
    store = new FileAgentTimelineStore({ directory });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips committed rows with turn and provider message ids", async () => {
    await store.bulkInsert("a", [
      row(1, "one", { turnId: "turn-1" }),
      row(2, "two", {
        turnId: "turn-1",
        providerMessageId: "pm-2",
      }),
    ]);

    expect(await store.getCommittedRows("a")).toEqual([
      {
        seq: 1,
        timestamp: TIMESTAMP,
        item: { type: "user_message", text: "one", clientMessageId: "c1" },
        turnId: "turn-1",
      },
      {
        seq: 2,
        timestamp: TIMESTAMP,
        item: { type: "user_message", text: "two", clientMessageId: "c2" },
        turnId: "turn-1",
        providerMessageId: "pm-2",
      },
    ]);
    expect(await store.getLatestCommittedSeq("a")).toBe(2);
  });

  it("applies updateCommittedRow last-wins per seq", async () => {
    await store.bulkInsert("a", [row(1, "one")]);
    await store.updateCommittedRow("a", { ...row(1, "one"), providerMessageId: "pm-1" });

    const rows = await store.getCommittedRows("a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerMessageId).toBe("pm-1");
    expect(rows[0]?.item).toEqual({ type: "user_message", text: "one", clientMessageId: "c1" });
  });

  it("reports zero latest seq for an unknown agent", async () => {
    expect(await store.getLatestCommittedSeq("missing")).toBe(0);
    expect(await store.getCommittedRows("missing")).toEqual([]);
    expect(await store.getLastItem("missing")).toBeNull();
    expect(await store.getLastAssistantMessage("missing")).toBeNull();
  });

  it("serves committed pages with the projected selection", async () => {
    await store.bulkInsert(
      "a",
      Array.from({ length: 10 }, (_, i) => row(i + 1, `m${i + 1}`)),
    );
    const page = await store.fetchCommitted("a", {
      direction: "before",
      cursor: { epoch: "e", seq: 10 },
      limit: 3,
    });

    expect(page.rows.map((r) => r.seqStart)).toEqual([7, 8, 9]);
    expect(page.startSeq).toBe(7);
    expect(page.endSeq).toBe(9);
    expect(page.hasOlder).toBe(true);
    // Row 10 exists past the page, so the page is not the newest.
    expect(page.hasNewer).toBe(true);
    expect(page.window).toEqual({ minSeq: 1, maxSeq: 10, nextSeq: 11 });
  });

  it("skips a torn trailing line from a crashed write", async () => {
    writeFileSync(
      path.join(directory, "a.jsonl"),
      [
        JSON.stringify(row(1, "one")),
        '{"seq":2,"timestamp":"2026-01-01T00:00:01.000Z","item":{"type":"user_mess',
      ].join("\n"),
    );

    expect(await store.getCommittedRows("a")).toEqual([
      {
        seq: 1,
        timestamp: TIMESTAMP,
        item: { type: "user_message", text: "one", clientMessageId: "c1" },
      },
    ]);
    expect(await store.getLatestCommittedSeq("a")).toBe(1);
  });

  it("serializes per-agent writes so a delete wins after an earlier insert", async () => {
    const insert = store.bulkInsert("a", [row(1, "one")]);
    const del = store.deleteAgent("a");
    await Promise.all([insert, del]);

    expect(await store.getCommittedRows("a")).toEqual([]);
    expect(await store.getLatestCommittedSeq("a")).toBe(0);
  });

  it("appends committed rows in order across interleaved inserts", async () => {
    await Promise.all([
      store.bulkInsert("a", [row(1, "one")]),
      store.bulkInsert("a", [row(2, "two")]),
      store.bulkInsert("a", [row(3, "three")]),
    ]);
    expect((await store.getCommittedRows("a")).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("returns the last item and the trailing assistant message", async () => {
    await store.bulkInsert("a", [
      row(1, "prompt"),
      { seq: 2, timestamp: TIMESTAMP, item: { type: "assistant_message", text: "He" } },
      { seq: 3, timestamp: TIMESTAMP, item: { type: "assistant_message", text: "llo" } },
    ]);

    expect(await store.getLastItem("a")).toEqual({ type: "assistant_message", text: "llo" });
    expect(await store.getLastAssistantMessage("a")).toBe("Hello");
  });

  it("matches the manager's trailing-run last-message semantics across message ids", async () => {
    // AgentManager.getLastAssistantMessage reads the trailing contiguous run
    // of assistant text: from the in-memory projection while the agent is
    // live, from this store after a restart. The two paths must agree on
    // where the run starts and stops, including at message-id boundaries.
    await store.bulkInsert("a", [
      row(1, "prompt"),
      {
        seq: 2,
        timestamp: TIMESTAMP,
        item: { type: "assistant_message", text: "A", messageId: "m-a" },
      },
      {
        seq: 3,
        timestamp: TIMESTAMP,
        item: { type: "assistant_message", text: "B", messageId: "m-b" },
      },
    ]);
    expect(await store.getLastAssistantMessage("a")).toBe("AB");

    await store.bulkInsert("b", [
      row(1, "prompt"),
      {
        seq: 2,
        timestamp: TIMESTAMP,
        item: { type: "assistant_message", text: "A", messageId: "m-a" },
      },
      row(3, "follow-up"),
      {
        seq: 4,
        timestamp: TIMESTAMP,
        item: { type: "assistant_message", text: "B", messageId: "m-b" },
      },
    ]);
    expect(await store.getLastAssistantMessage("b")).toBe("B");
  });

  it("isolates a torn trailing line before the next append lands", async () => {
    await store.bulkInsert("a", [row(1, "one")]);
    // A crash mid-write leaves the newest line unterminated.
    await appendFile(
      path.join(directory, "a.jsonl"),
      '{"seq":2,"timestamp":"2026-01-01T00:00:01.000Z","item":{"type":"user_mess',
      "utf8",
    );

    await store.bulkInsert("a", [row(3, "three")]);

    expect((await store.getCommittedRows("a")).map((r) => r.seq)).toEqual([1, 3]);
  });

  it("mints distinct seqs for concurrent appendCommitted calls", async () => {
    const [first, second] = await Promise.all([
      store.appendCommitted("a", { type: "user_message", text: "one", clientMessageId: "c1" }),
      store.appendCommitted("a", { type: "user_message", text: "two", clientMessageId: "c2" }),
    ]);

    expect(first.seq).not.toBe(second.seq);
    expect((await store.getCommittedRows("a")).map((r) => r.seq).sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it("readTailRows serves bounded newest rows below a max seq", async () => {
    await store.bulkInsert(
      "a",
      Array.from({ length: 10 }, (_, i) => row(i + 1, `m${i + 1}`)),
    );
    await store.updateCommittedRow("a", { ...row(10, "ten"), providerMessageId: "pm-10" });

    const first = await store.readTailRows("a", { offset: 0, count: 3 });
    expect(first.rows.map((r) => r.seq)).toEqual([8, 9, 10]);
    expect(first.atStart).toBe(false);
    // The newest line for a seq wins, like getCommittedRows.
    expect(first.rows[2]?.providerMessageId).toBe("pm-10");

    const rest = await store.readTailRows("a", { offset: 3, count: 7 });
    expect(rest.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rest.atStart).toBe(true);

    const below = await store.readTailRows("a", { maxSeq: 4, offset: 0, count: 10 });
    expect(below.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(below.atStart).toBe(true);
  });

  it("returns the newest seqs when an update for an old seq sits at the end of the log", async () => {
    await store.bulkInsert(
      "a",
      Array.from({ length: 300 }, (_, i) => row(i + 1, `m${i + 1}`)),
    );
    await store.updateCommittedRow("a", {
      ...row(1, "one-updated"),
      providerMessageId: "pm-1",
    });

    // The trailing update inflates the distinct count seen from the tail;
    // stopping at the first `count` distinct seqs returns [1, 299, 300] and
    // strands 298, so the scan must reach past the newest `count` seqs.
    const page = await store.readTailRows("a", { offset: 0, count: 3 });
    expect(page.rows.map((r) => r.seq)).toEqual([298, 299, 300]);
    expect(page.rows[0]?.item).toEqual(row(298, "m298").item);
    expect(page.atStart).toBe(false);

    const rest = await store.readTailRows("a", { offset: 3, count: 297 });
    expect(rest.rows.map((r) => r.seq)).toEqual(Array.from({ length: 297 }, (_, i) => i + 1));
    // The newest line for a returned seq still wins.
    expect(rest.rows[0]?.providerMessageId).toBe("pm-1");
    expect(rest.atStart).toBe(true);
  });

  it("fetchCommitted tail pages serve the newest projected rows with hasOlder", async () => {
    await store.bulkInsert(
      "a",
      Array.from({ length: 100 }, (_, i) => row(i + 1, `m${i + 1}`)),
    );

    const page = await store.fetchCommitted("a", { direction: "tail", limit: 3 });

    expect(page.rows.map((r) => r.seqStart)).toEqual([98, 99, 100]);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(false);
    expect(page.startSeq).toBe(98);
    expect(page.endSeq).toBe(100);
  });

  it("returns the newest seqs when a bulk re-append of old rows sits at the end of the log", async () => {
    const payload = "x".repeat(400);
    const reAppendedRows = (count: number) =>
      Array.from({ length: count }, (_, i) => row(i + 1, `m${i + 1} ${payload}`));
    await store.bulkInsert("a", reAppendedRows(2000));
    // A failed-write retry (or an enrichment flush) re-appends old rows after
    // the newest mints, so the tail of the file no longer reflects seq order.
    await store.bulkInsert("a", reAppendedRows(1000));

    const page = await store.fetchCommitted("a", { direction: "tail", limit: 200 });
    expect(page.rows.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, i) => 1801 + i));
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(false);

    const read = await store.readTailRows("a", { maxSeq: 1994, offset: 0, count: 200 });
    expect(read.rows.map((r) => r.seq)).toEqual(Array.from({ length: 200 }, (_, i) => 1795 + i));
  });

  it("keeps scanning past a stable cut until the tail page holds the requested projected count", async () => {
    const rows: AgentTimelineRow[] = [];
    for (let i = 1; i <= 300; i += 1) {
      for (const suffix of ["a", "b"]) {
        rows.push({
          seq: rows.length + 1,
          timestamp: TIMESTAMP,
          item: {
            type: "assistant_message",
            text: `${suffix}${i}${suffix === "a" ? " " : ""}`,
            messageId: `m${i}`,
          },
        });
      }
    }
    await store.bulkInsert("a", rows);

    // Each of the 300 projected items is two chunk rows: the first 256-row
    // batch projects to only 128 items, so the stable cut above it must not
    // end a 200-item page while older items can still fill it.
    const page = await store.fetchCommitted("a", { direction: "tail", limit: 200 });

    expect(page.rows).toHaveLength(200);
    expect(page.startSeq).toBe(201);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(false);
    expect(page.rows[0]?.item).toEqual({
      type: "assistant_message",
      text: "a101 b101",
      messageId: "m101",
    });
  });
});
