import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { AgentTimelineFetchOptions } from "../agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import type { DaemonDatabase, ReadSql, WriteSql } from "../../database/index.js";
import { MemoryTimelineBackend } from "./internal/memory-backend.js";
import { SqliteTimelineBackend } from "./internal/sqlite-backend.js";
import { nextTestDatabasePath } from "../../test-utils/test-database-path.js";
import { DeferredTimelineBackend, openTestTimelineDatabase } from "./testing.js";
import {
  AgentTimeline,
  TimelineClosedError,
  type TimelineEntry,
  type TimelineScope,
} from "./index.js";

const scope: TimelineScope = { agentId: "agent" };
const TIMESTAMP = "2026-11-25T10:00:00.000Z";

function entry(item: AgentTimelineItem, fields: Omit<TimelineEntry, "item"> = {}): TimelineEntry {
  return { item, timestamp: TIMESTAMP, ...fields };
}

function tool(callId: string, status: "running" | "completed", label = callId): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text", label },
  };
}

function descriptor(id: string, toolCallId: string | null): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "agent",
    parentSubagentId: null,
    provider: "claude",
    title: null,
    description: null,
    status: "running",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    toolCallId,
    cwd: null,
    subtitle: null,
  };
}

function seededRandom(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * bound);
  };
}

/** Every row of every timeline table, to compare stored state before and after a failed write. */
function dumpTables(database: DaemonDatabase): Record<string, unknown[]> {
  return database.read((sql) => {
    const tables = sql
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'timeline_%' ORDER BY name",
      )
      .map((table) => table.name);
    return Object.fromEntries(tables.map((table) => [table, sql.all(`SELECT * FROM ${table}`)]));
  });
}

/** Counts the rows the backend's queries return, to prove a read touches a bounded slice. */
class CountingDatabase implements DaemonDatabase {
  rowsRead = 0;

  constructor(private readonly inner: DaemonDatabase) {}

  write<T>(fn: (sql: WriteSql) => T): T {
    return this.inner.write((sql) => fn({ ...this.counting(sql), run: sql.run, exec: sql.exec }));
  }

  read<T>(fn: (sql: ReadSql) => T): T {
    return this.inner.read((sql) => fn(this.counting(sql)));
  }

  close(): void {
    this.inner.close();
  }

  private counting(sql: ReadSql): ReadSql {
    return {
      get: (query, ...params) => {
        const row = sql.get(query, ...params);
        if (row !== undefined) this.rowsRead += 1;
        return row as never;
      },
      all: (query, ...params) => {
        const rows = sql.all(query, ...params);
        this.rowsRead += rows.length;
        return rows as never;
      },
      iterate: <T>(query: string, ...params: Parameters<ReadSql["get"]>[1][]) => {
        const rows = sql.iterate<T>(query, ...params);
        const count = () => (this.rowsRead += 1);
        return {
          *[Symbol.iterator]() {
            for (const row of rows) {
              count();
              yield row;
            }
          },
        };
      },
    };
  }
}

describe("SQLite timeline backend against the memory backend", () => {
  it("stores the same history and serves the same pages on seeded randomized timelines", () => {
    const random = seededRandom(0x5eed_0001);
    for (let scenario = 0; scenario < 40; scenario++) {
      const memory = new MemoryTimelineBackend();
      const sqlite = new SqliteTimelineBackend(openTestTimelineDatabase());
      const backends = [memory, sqlite] as const;
      for (const backend of backends) backend.create(scope, { epoch: "e" });
      let turn = 0;
      for (let step = 0; step < 120; step++) {
        const roll = random(20);
        const identity = String(random(6));
        const text = `${scenario}-${step}`;
        if (roll === 0) {
          const prompts = memory.prompts(scope);
          if (prompts.length > 0) {
            const retireFromSeq = prompts[random(prompts.length)].seqStart;
            const results = backends.map((backend) =>
              backend.retire(scope, { retireFromSeq, selectChildren: () => [] }),
            );
            expect(results[1]).toEqual(results[0]);
          }
          continue;
        }
        if (roll === 1) {
          const turnId = random(2) === 0 ? String(turn) : undefined;
          const metrics = [{ name: "tokens", value: step }] as never;
          const results = backends.map((backend) =>
            backend.stampTurnMetrics(scope, metrics, turnId === undefined ? {} : { turnId }),
          );
          expect(results[1]).toEqual(results[0]);
          continue;
        }
        if (roll === 2) {
          const clientMessageId = `client-${random(step + 1)}`;
          const results = backends.map((backend) =>
            backend.attachProviderMessageId(scope, clientMessageId, `provider-${step}`),
          );
          expect(results[1]).toEqual(results[0]);
          continue;
        }
        if (random(8) === 0) turn += 1;
        const items: AgentTimelineItem[] = [
          { type: "user_message", text, messageId: `m-${step}`, clientMessageId: `client-${step}` },
          { type: "user_message", text, messageId: `m-${step}` },
          { type: "assistant_message", text },
          { type: "assistant_message", text, messageId: identity },
          { type: "reasoning", text },
          tool(identity, random(2) === 0 ? "running" : "completed", text),
          {
            type: "plugin",
            id: identity,
            pluginId: "test",
            kind: "state",
            version: 1,
            data: { text },
          },
        ];
        const next = entry(items[random(items.length)], { turnId: String(turn) });
        const retired = backends.map((backend) => backend.isRetired(scope, next));
        expect(retired[1]).toBe(retired[0]);
        const results = backends.map((backend) => backend.append(scope, [next]));
        expect(results[1]).toEqual(results[0]);
      }
      expectSameHistory(memory, sqlite);
      // Seeding from projected rows, as an import does, keeps both in step too.
      const rows = memory.readRows(scope);
      for (const backend of backends) backend.create({ agentId: "seeded" }, { rows, epoch: "e" });
      expectSameHistory(memory, sqlite, { agentId: "seeded" });
    }
  });
});

function expectSameHistory(
  memory: MemoryTimelineBackend,
  sqlite: SqliteTimelineBackend,
  target: TimelineScope = scope,
): void {
  expect(sqlite.head(target)).toEqual(memory.head(target));
  expect(sqlite.readRows(target)).toEqual(memory.readRows(target));
  expect(sqlite.retiredRows(target)).toEqual(memory.retiredRows(target));
  expect(sqlite.prompts(target)).toEqual(memory.prompts(target));
  expect(sqlite.lastItem(target)).toEqual(memory.lastItem(target));
  expect(sqlite.lastAssistantMessage(target)).toEqual(memory.lastAssistantMessage(target));
  const maxSeq = memory.head(target)!.seq;
  for (const direction of ["tail", "before", "after"] as const) {
    for (const wholeTurns of [false, true]) {
      for (const limit of [0, 1, 3, 10]) {
        for (const cursorSeq of [0, 1, Math.floor(maxSeq / 3), Math.floor(maxSeq / 2), maxSeq]) {
          const options: AgentTimelineFetchOptions = {
            direction,
            wholeTurns,
            limit,
            cursor: { epoch: "e", seq: cursorSeq },
          };
          expect({ options, page: sqlite.fetch(target, options) }).toEqual({
            options,
            page: memory.fetch(target, options),
          });
        }
      }
    }
  }
}

describe("SQLite timeline durability", () => {
  it("keeps rows, turns, metrics, provider ids, rewinds, and children across a restart", async () => {
    const file = nextTestDatabasePath();
    let database = openTestTimelineDatabase(file);
    let timeline = new AgentTimeline(new SqliteTimelineBackend(database));
    await timeline.create(scope, { epoch: "e" });
    await timeline.ingest(
      scope,
      entry(
        { type: "user_message", text: "first", messageId: "m1", clientMessageId: "c1" },
        { turnId: "t1" },
      ),
    );
    await timeline.attachProviderMessageId(scope, "c1", "p1");
    await timeline.append(scope, [
      entry({ type: "assistant_message", text: "Hel" }, { turnId: "t1" }),
      entry({ type: "assistant_message", text: "lo" }, { turnId: "t1" }),
      entry(tool("spawn", "running"), { turnId: "t1" }),
    ]);
    await timeline.stampTurnMetrics(scope, [{ name: "tokens", value: 3 }] as never, {
      turnId: "t1",
    });
    await timeline.append(scope, [
      entry({ type: "user_message", text: "second", messageId: "m2" }, { turnId: "t2" }),
      entry({ type: "assistant_message", text: "Done" }, { turnId: "t2" }),
    ]);
    const child: TimelineScope = { agentId: "agent", subagentId: "child" };
    await timeline.recordChild(child, () => descriptor("child", "spawn"));
    await timeline.recordChildEntries(child, [entry({ type: "assistant_message", text: "kid" })]);
    const intent = await timeline.beginRewind(scope, "m1");
    await timeline.recordRewindCut(scope, intent.id, { kind: "at_target" });
    const rowsBefore = await timeline.readRows(scope);
    const headBefore = await timeline.describe(scope);
    await timeline.close();
    database.close();

    database = openTestTimelineDatabase(file);
    timeline = new AgentTimeline(new SqliteTimelineBackend(database));
    expect(await timeline.describe(scope)).toEqual(headBefore);
    expect(headBefore?.rewind).toMatchObject({ id: intent.id, cut: { kind: "at_target" } });
    const rowsAfter = await timeline.readRows(scope);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.map((row) => row.turnId)).toEqual(["t1", "t1", "t1", "t2", "t2"]);
    expect(rowsAfter[0].providerMessageId).toBe("p1");
    expect(rowsAfter[1]).toMatchObject({
      item: { text: "Hello" },
      turnMetrics: [{ name: "tokens", value: 3 }],
    });
    // Turn ids survive, so a whole-turns tail still stops at the last turn (#10030).
    const lastTurn = await timeline.fetch(scope, { direction: "tail", limit: 1, wholeTurns: true });
    expect(lastTurn.rows.map((row) => row.turnId)).toEqual(["t2", "t2"]);
    expect(await timeline.listChildren("agent")).toEqual([
      { subagentId: "child", descriptor: descriptor("child", "spawn"), retired: false },
    ]);
    expect((await timeline.readRows(child)).map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "kid" },
    ]);

    // The rewind opened before the restart completes after it.
    const completion = await timeline.completeRewind(scope, intent.id);
    expect(completion).toMatchObject({ kind: "retired", retiredChildIds: ["child"] });
    await timeline.close();
    database.close();

    database = openTestTimelineDatabase(file);
    const backend = new SqliteTimelineBackend(database);
    timeline = new AgentTimeline(backend);
    expect(await timeline.readRows(scope)).toEqual([]);
    expect(backend.retiredRows(scope)).toEqual(rowsBefore);
    expect(await timeline.describe(scope)).toMatchObject({ retirementCount: 1, rewind: null });
    expect(await timeline.listChildren("agent")).toMatchObject([
      { subagentId: "child", retired: true },
    ]);
    // Late output of a retired tool call is still dropped.
    expect(await timeline.ingest(scope, entry(tool("spawn", "completed")))).toEqual({
      kind: "dropped",
    });
    const tail = await timeline.fetch(scope, { direction: "tail" });
    expect(tail.retirements).toEqual([{ seq: 7, retireFromSeq: 1 }]);
    await timeline.close();
    database.close();
  });

  it("finishes queued writes on close, then refuses new ones", async () => {
    const file = nextTestDatabasePath();
    let database = openTestTimelineDatabase(file);
    const timeline = new AgentTimeline(
      new DeferredTimelineBackend(new SqliteTimelineBackend(database)),
    );
    await timeline.create(scope, { epoch: "e" });
    const writes = ["a", "b", "c"].map((text) =>
      timeline.append(scope, [entry({ type: "user_message", text })]),
    );
    await timeline.close();
    await expect(
      timeline.append(scope, [entry({ type: "user_message", text: "late" })]),
    ).rejects.toBeInstanceOf(TimelineClosedError);
    // Nothing is left to wait for, so code that orders itself behind the timeline still runs.
    await expect(timeline.settled(scope)).resolves.toBeUndefined();
    await Promise.all(writes);
    database.close();

    database = openTestTimelineDatabase(file);
    const rows = new SqliteTimelineBackend(database).readRows(scope);
    expect(rows.map((row) => row.item)).toMatchObject([
      { text: "a" },
      { text: "b" },
      { text: "c" },
    ]);
    database.close();
  });
});

describe("SQLite timeline write failures", () => {
  function failOn(database: DaemonDatabase, table: string): void {
    database.write((sql) =>
      sql.exec(
        `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} ` +
          "BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      ),
    );
  }

  it("leaves no part of a failed append", () => {
    const database = openTestTimelineDatabase();
    const backend = new SqliteTimelineBackend(database);
    backend.create(scope, { epoch: "e" });
    backend.append(scope, [entry({ type: "user_message", text: "kept" })]);
    const before = dumpTables(database);
    failOn(database, "timeline_text");
    // The prompt is written before the reply's text fails.
    expect(() =>
      backend.append(scope, [
        entry({ type: "user_message", text: "lost" }),
        entry({ type: "assistant_message", text: "lost" }),
      ]),
    ).toThrow(/disk full/);
    expect(dumpTables(database)).toEqual(before);
    expect(backend.head(scope)).toMatchObject({ seq: 1, size: 1 });
    database.close();
  });

  it("leaves no part of a failed retirement", () => {
    const database = openTestTimelineDatabase();
    const backend = new SqliteTimelineBackend(database);
    backend.create(scope, { epoch: "e" });
    backend.append(scope, [
      entry({ type: "user_message", text: "one", messageId: "m1" }, { turnId: "t1" }),
      entry(tool("call", "running"), { turnId: "t1" }),
    ]);
    backend.setChild({ agentId: "agent", subagentId: "child" }, descriptor("child", "call"));
    backend.setRewind(scope, { id: "r", messageId: "m1", targetSeq: 1 });
    const before = dumpTables(database);
    failOn(database, "timeline_retirements");
    // Rows, keys, ranges, and the child are written before the retirement fails.
    expect(() =>
      backend.retire(scope, { retireFromSeq: 1, selectChildren: () => ["child"] }),
    ).toThrow(/disk full/);
    expect(dumpTables(database)).toEqual(before);
    expect(backend.isRetired(scope, entry(tool("call", "completed")))).toBe(false);
    database.close();
  });
});

describe("SQLite timeline reads", () => {
  function longHistory(): { database: CountingDatabase; backend: SqliteTimelineBackend } {
    const database = new CountingDatabase(openTestTimelineDatabase());
    const backend = new SqliteTimelineBackend(database);
    backend.create(scope, { epoch: "e" });
    for (let batch = 0; batch < 50; batch++) {
      const entries: TimelineEntry[] = [];
      for (let index = 0; index < 10; index++) {
        const turnId = `t${batch * 10 + index}`;
        entries.push(
          entry({ type: "user_message", text: turnId, messageId: turnId }, { turnId }),
          entry(tool(`${turnId}-call`, "completed"), { turnId }),
          entry({ type: "assistant_message", text: "a" }, { turnId }),
          entry({ type: "assistant_message", text: "b" }, { turnId }),
        );
      }
      backend.append(scope, entries);
    }
    return { database, backend };
  }

  it("reads a bounded slice of a long history for a page", () => {
    const { database, backend } = longHistory();
    expect(backend.head(scope)).toMatchObject({ seq: 2000, size: 1500 });
    const pages: AgentTimelineFetchOptions[] = [
      { direction: "tail", limit: 20 },
      { direction: "tail", limit: 20, wholeTurns: true },
      { direction: "before", limit: 20, cursor: { epoch: "e", seq: 1000 } },
      { direction: "before", limit: 20, cursor: { epoch: "e", seq: 1000 }, wholeTurns: true },
      { direction: "after", limit: 20, cursor: { epoch: "e", seq: 1000 } },
    ];
    for (const options of pages) {
      database.rowsRead = 0;
      expect(backend.fetch(scope, options).rows.length).toBeGreaterThanOrEqual(20);
      expect(database.rowsRead, JSON.stringify(options)).toBeLessThan(150);
    }
    for (const read of [
      () => backend.head(scope),
      () => backend.lastItem(scope),
      () => backend.lastAssistantMessage(scope),
      () => backend.isRetired(scope, entry(tool("t3-call", "completed"))),
      () => backend.findSubmittedPrompt(scope, "absent"),
      () => backend.stampTurnMetrics(scope, [], { turnId: "t499" }),
    ]) {
      database.rowsRead = 0;
      read();
      expect(database.rowsRead).toBeLessThan(20);
    }
    database.close();
  });

  it("writes a streamed chunk without rewriting the message's earlier text", () => {
    const database = openTestTimelineDatabase();
    const backend = new SqliteTimelineBackend(database);
    backend.create(scope, { epoch: "e" });
    const storedRowSize = () =>
      database.read(
        (sql) => sql.get<{ size: number }>("SELECT length(row) AS size FROM timeline_rows")!.size,
      );
    for (let chunk = 0; chunk < 100; chunk++) {
      backend.append(scope, [entry({ type: "assistant_message", text: "x".repeat(1000) })]);
    }
    // The row holds only its metadata; the 100,000 characters of text are chunks beside it.
    expect(storedRowSize()).toBeLessThan(300);
    expect(backend.lastAssistantMessage(scope)).toHaveLength(100_000);
    database.close();
  });

  it("reads back streamed text exactly, including a NUL and a pair split across chunks", () => {
    const file = nextTestDatabasePath();
    const chunks = ["before\0after ", "\ud83d", "\ude00 end"];
    const writer = openTestTimelineDatabase(file);
    const written = new SqliteTimelineBackend(writer);
    written.create(scope, { epoch: "e" });
    for (const text of chunks) {
      written.append(scope, [entry({ type: "assistant_message", text })]);
    }
    writer.close();

    const reopened = new SqliteTimelineBackend(openTestTimelineDatabase(file));
    expect(reopened.readRows(scope).map((row) => row.item)).toEqual([
      { type: "assistant_message", text: chunks.join("") },
    ]);
  });
});
