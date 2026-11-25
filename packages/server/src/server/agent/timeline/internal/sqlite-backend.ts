import { randomUUID } from "node:crypto";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import type { AgentMetric, AgentTimelineItem } from "../../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import {
  TimelineProjection,
  coalesceTimelineRetirements,
  continuesAssistantMessage,
  foldTimelineRow,
  selectProjectedEntriesAfter,
  type ProjectedTimelinePageOptions,
  type ProjectedTimelinePageSelection,
  type ProjectedTimelineRow,
  type TimelineRetirement,
  type TimelineSeqRange,
} from "../../timeline-projection.js";
import type { ProviderSubagentDescriptor } from "../../provider-subagents/store.js";
import type { DaemonDatabase, ReadSql, SchemaModule, WriteSql } from "../../../database/index.js";
import type {
  AgentTimelineBackend,
  RetiredChildSelector,
  TimelineBackendAppendResult,
  TimelineBackendRetireResult,
  TimelineChild,
  TimelineEntry,
  TimelineHead,
  TimelinePrompt,
  TimelineRewindIntent,
  TimelineScope,
  TimelineSeed,
} from "./backend.js";
import { UnknownTimelineError } from "./backend.js";
import { fetchTimelinePage } from "./fetch-page.js";
import { buildSourceRow } from "./source-row.js";

/**
 * Tables of the timeline store. `timeline_rows` holds projected rows: `row` is the row's JSON,
 * with the text of streamed assistant and reasoning rows kept in `timeline_text` instead, one
 * chunk per source row, so a streamed chunk never rewrites the message. A chunk is stored as a JSON
 * string: node:sqlite reads a TEXT value only up to its first NUL, and a chunk can end inside a
 * surrogate pair, which UTF-8 cannot hold. `retired_by` is the seq of
 * the retirement that took the row out of the conversation. `span_start` marks rows that start a
 * source-coverage span (no earlier active row's `seq_end` reaches them). `identity_live` marks the
 * row an item identity's next update merges into. `timeline_source_ranges` maps every source seq
 * to its active row, or to none for retired rows and retirements. `timeline_retired_keys` holds the
 * turn ids and tool call ids late output is dropped for.
 */
const SCHEMA_V1 = `
CREATE TABLE timeline_scopes (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  subagent_id TEXT,
  epoch TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  min_seq INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  active_max_seq_end INTEGER NOT NULL,
  retirement_count INTEGER NOT NULL,
  rewind TEXT,
  descriptor TEXT,
  child_retired INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX timeline_scopes_root ON timeline_scopes (agent_id) WHERE subagent_id IS NULL;
CREATE UNIQUE INDEX timeline_scopes_child ON timeline_scopes (agent_id, subagent_id)
  WHERE subagent_id IS NOT NULL;

CREATE TABLE timeline_rows (
  scope_id INTEGER NOT NULL REFERENCES timeline_scopes (id) ON DELETE CASCADE,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  retired_by INTEGER,
  span_start INTEGER NOT NULL,
  identity TEXT,
  identity_live INTEGER NOT NULL,
  turn_id TEXT,
  turn_trigger INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  client_message_id TEXT,
  row TEXT NOT NULL,
  PRIMARY KEY (scope_id, seq_start)
);
CREATE INDEX timeline_rows_active ON timeline_rows (scope_id, seq_start) WHERE retired_by IS NULL;
CREATE INDEX timeline_rows_span ON timeline_rows (scope_id, seq_start)
  WHERE retired_by IS NULL AND span_start = 1;
CREATE INDEX timeline_rows_identity ON timeline_rows (scope_id, identity) WHERE identity_live = 1;
CREATE INDEX timeline_rows_turn ON timeline_rows (scope_id, turn_id, seq_start)
  WHERE retired_by IS NULL AND turn_id IS NOT NULL;
CREATE INDEX timeline_rows_type ON timeline_rows (scope_id, item_type, seq_start)
  WHERE retired_by IS NULL;
CREATE INDEX timeline_rows_client_message ON timeline_rows (scope_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX timeline_rows_retired ON timeline_rows (scope_id, retired_by, seq_start)
  WHERE retired_by IS NOT NULL;

CREATE TABLE timeline_text (
  scope_id INTEGER NOT NULL REFERENCES timeline_scopes (id) ON DELETE CASCADE,
  seq_start INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  text_json TEXT NOT NULL,
  PRIMARY KEY (scope_id, seq_start, seq)
);

CREATE TABLE timeline_source_ranges (
  scope_id INTEGER NOT NULL REFERENCES timeline_scopes (id) ON DELETE CASCADE,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  row_seq_start INTEGER,
  PRIMARY KEY (scope_id, start_seq)
);

CREATE TABLE timeline_retirements (
  scope_id INTEGER NOT NULL REFERENCES timeline_scopes (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  retire_from_seq INTEGER NOT NULL,
  PRIMARY KEY (scope_id, seq)
);

CREATE TABLE timeline_retired_keys (
  scope_id INTEGER NOT NULL REFERENCES timeline_scopes (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (scope_id, kind, key)
);
`;

/** The timeline store's schema in the daemon database. */
export const timelineSchema: SchemaModule = {
  name: "timeline",
  migrations: [{ up: (sql) => sql.exec(SCHEMA_V1) }],
};

interface ScopeRecord {
  id: number;
  epoch: string;
  next_seq: number;
  min_seq: number;
  active_count: number;
  active_max_seq_end: number;
  retirement_count: number;
  rewind: string | null;
  descriptor: string | null;
  child_retired: number;
}

interface RowRecord {
  seq_start: number;
  item_type: string;
  row: string;
}

/** The columns turn and message boundaries are decided on, without the row's payload. */
interface RowShape {
  seq_start: number;
  turn_id: string | null;
  turn_trigger: number;
  item_type: string;
}

interface SourceRangeRecord {
  start_seq: number;
  end_seq: number;
  row_seq_start: number | null;
}

interface RetirementRecord {
  seq: number;
  retire_from_seq: number;
}

const SCOPE_COLUMNS =
  "id, epoch, next_seq, min_seq, active_count, active_max_seq_end, retirement_count, rewind, " +
  "descriptor, child_retired";
const SHAPE_COLUMNS = "seq_start, turn_id, turn_trigger, item_type";
const ACTIVE = "scope_id = ? AND retired_by IS NULL";

type TextItemType = "assistant_message" | "reasoning";

function isTextItemType(type: string): type is TextItemType {
  return type === "assistant_message" || type === "reasoning";
}

/** Durable backend: history lives in the daemon database and survives restarts. */
export class SqliteTimelineBackend implements AgentTimelineBackend {
  constructor(private readonly database: DaemonDatabase) {}

  create(scope: TimelineScope, seed: TimelineSeed): TimelineHead {
    return this.database.write((sql) => describe(createScope(sql, scope, seed)));
  }

  delete(scope: TimelineScope): void {
    this.database.write((sql) => {
      if (scope.subagentId === undefined) {
        sql.run("DELETE FROM timeline_scopes WHERE agent_id = ?", scope.agentId);
      } else {
        sql.run(
          "DELETE FROM timeline_scopes WHERE agent_id = ? AND subagent_id = ?",
          scope.agentId,
          scope.subagentId,
        );
      }
    });
  }

  head(scope: TimelineScope): TimelineHead | null {
    return this.database.read((sql) => {
      const record = findScope(sql, scope);
      return record ? describe(record) : null;
    });
  }

  append(scope: TimelineScope, entries: readonly TimelineEntry[]): TimelineBackendAppendResult {
    return this.database.write((sql) => {
      const record = requireScope(sql, scope);
      const timestamp = new Date().toISOString();
      const rows = entries.map((entry) => {
        const row = buildSourceRow(entry, record.next_seq, timestamp);
        foldSourceRow(sql, record, row);
        record.next_seq = row.seq + 1;
        if (record.min_seq === 0) record.min_seq = row.seq;
        return row;
      });
      saveScopeCounters(sql, record);
      // The rows are built for this call, so the caller can own them.
      return { rows, head: describe(record) };
    });
  }

  isRetired(scope: TimelineScope, entry: TimelineEntry): boolean {
    return this.database.read((sql) => {
      const { id } = requireScope(sql, scope);
      if (entry.turnId !== undefined && hasRetiredKey(sql, id, "turn", entry.turnId)) return true;
      const identity = timelineItemIdentity(entry.item);
      if (identity === null || findIdentityRow(sql, id, identity)) return false;
      return hasRetiredKey(sql, id, "identity", identity);
    });
  }

  prompts(scope: TimelineScope): TimelinePrompt[] {
    return this.database.read((sql) => {
      const { id } = requireScope(sql, scope);
      return sql
        .all<RowRecord>(
          `SELECT seq_start, item_type, row FROM timeline_rows WHERE ${ACTIVE} ` +
            "AND item_type = 'user_message' ORDER BY seq_start",
          id,
        )
        .map((record) => {
          const row = parseRow(record);
          const item = row.item as Extract<AgentTimelineItem, { type: "user_message" }>;
          return {
            seqStart: row.seqStart,
            messageId: item.messageId,
            providerMessageId: row.providerMessageId,
            submitted: item.clientMessageId !== undefined,
          };
        });
    });
  }

  setRewind(scope: TimelineScope, rewind: TimelineRewindIntent | null): TimelineHead {
    return this.database.write((sql) => {
      const record = requireScope(sql, scope);
      record.rewind = rewind ? JSON.stringify(rewind) : null;
      sql.run("UPDATE timeline_scopes SET rewind = ? WHERE id = ?", record.rewind, record.id);
      return describe(record);
    });
  }

  retire(
    scope: TimelineScope,
    input: { retireFromSeq: number; selectChildren: RetiredChildSelector },
  ): TimelineBackendRetireResult {
    return this.database.write((sql) => {
      const record = requireScope(sql, scope);
      const retirement: TimelineRetirement = {
        seq: record.next_seq,
        retireFromSeq: input.retireFromSeq,
      };
      const retiredRows = readActiveRows(sql, record.id, { fromSeq: input.retireFromSeq });
      sql.run(
        "UPDATE timeline_rows SET retired_by = ?, identity_live = 0 " +
          `WHERE ${ACTIVE} AND seq_start >= ?`,
        retirement.seq,
        record.id,
        input.retireFromSeq,
      );
      for (const row of retiredRows) {
        if (row.item.type === "tool_call") {
          addRetiredKey(sql, record.id, "identity", row.item.callId);
        }
        if (row.turnId !== undefined && !hasActiveTurn(sql, record.id, row.turnId)) {
          addRetiredKey(sql, record.id, "turn", row.turnId);
        }
      }
      // Ranges of the retired rows stay covered, without a row. They start at or after their row.
      sql.run(
        "UPDATE timeline_source_ranges SET row_seq_start = NULL " +
          "WHERE scope_id = ? AND start_seq >= ? AND row_seq_start >= ?",
        record.id,
        input.retireFromSeq,
        input.retireFromSeq,
      );
      sql.run(
        "INSERT INTO timeline_source_ranges (scope_id, start_seq, end_seq, row_seq_start) " +
          "VALUES (?, ?, ?, NULL)",
        record.id,
        retirement.seq,
        retirement.seq,
      );
      sql.run(
        "INSERT INTO timeline_retirements (scope_id, seq, retire_from_seq) VALUES (?, ?, ?)",
        record.id,
        retirement.seq,
        retirement.retireFromSeq,
      );
      const retiredChildIds = [
        ...input.selectChildren(retiredRows, listChildren(sql, scope.agentId)),
      ];
      for (const subagentId of retiredChildIds) {
        sql.run(
          "UPDATE timeline_scopes SET child_retired = 1 WHERE agent_id = ? AND subagent_id = ?",
          scope.agentId,
          subagentId,
        );
      }
      record.next_seq = retirement.seq + 1;
      if (record.min_seq === 0) record.min_seq = retirement.seq;
      record.retirement_count += 1;
      record.active_count -= retiredRows.length;
      record.active_max_seq_end = activeMaxSeqEnd(sql, record.id);
      record.rewind = null;
      saveScopeCounters(sql, record);
      sql.run("UPDATE timeline_scopes SET rewind = NULL WHERE id = ?", record.id);
      return { retirement, retiredRows, retiredChildIds, head: describe(record) };
    });
  }

  children(agentId: string): TimelineChild[] {
    return this.database.read((sql) => listChildren(sql, agentId));
  }

  child(scope: TimelineScope): TimelineChild | null {
    if (scope.subagentId === undefined) return null;
    const subagentId = scope.subagentId;
    return this.database.read((sql) => {
      const record = findScope(sql, scope);
      return record ? toChild(subagentId, record) : null;
    });
  }

  setChild(scope: TimelineScope, descriptor: ProviderSubagentDescriptor): void {
    this.database.write((sql) => {
      const record = findScope(sql, scope) ?? createScope(sql, scope, {});
      sql.run(
        "UPDATE timeline_scopes SET descriptor = ? WHERE id = ?",
        JSON.stringify(descriptor),
        record.id,
      );
    });
  }

  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.database.write((sql) => {
      const { id } = requireScope(sql, scope);
      const record = findSubmittedPromptRecord(sql, id, clientMessageId);
      if (!record) return null;
      const row = { ...parseRow(record), providerMessageId };
      saveRow(sql, id, row);
      return row;
    });
  }

  stampTurnMetrics(
    scope: TimelineScope,
    metrics: AgentMetric[],
    options?: { turnId?: string },
  ): ProjectedTimelineRow | null {
    return this.database.write((sql) => {
      const { id } = requireScope(sql, scope);
      const footer = turnFooterSeq(sql, id, options?.turnId);
      if (footer === null) return null;
      const record = sql.get<RowRecord>(
        "SELECT seq_start, item_type, row FROM timeline_rows WHERE scope_id = ? AND seq_start = ?",
        id,
        footer,
      )!;
      const row = { ...parseRow(record), turnMetrics: metrics };
      saveRow(sql, id, row);
      return withText(sql, id, row);
    });
  }

  findSubmittedPrompt(scope: TimelineScope, clientMessageId: string): AgentTimelineRow | null {
    return this.database.read((sql) => {
      const { id } = requireScope(sql, scope);
      const record = findSubmittedPromptRecord(sql, id, clientMessageId);
      return record ? parseRow(record) : null;
    });
  }

  fetch(scope: TimelineScope, options: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    return this.database.read((sql) => {
      const record = requireScope(sql, scope);
      return fetchTimelinePage({
        history: {
          epoch: record.epoch,
          minSeq: record.min_seq,
          nextSeq: record.next_seq,
          retirementCount: record.retirement_count,
        },
        options,
        selectPage: (page) => new StoredPageSelection(sql, record).select(page),
      });
    });
  }

  readRows(scope: TimelineScope): ProjectedTimelineRow[] {
    return this.database.read((sql) => readActiveRows(sql, requireScope(sql, scope).id, {}));
  }

  lastItem(scope: TimelineScope): AgentTimelineItem | null {
    return this.database.read((sql) => {
      const record = requireScope(sql, scope);
      const last = lastSourceRange(sql, record.id);
      if (!last || last.end_seq !== record.next_seq - 1 || last.row_seq_start === null) return null;
      return readRow(sql, record.id, last.row_seq_start).item;
    });
  }

  lastAssistantMessage(scope: TimelineScope): string | null {
    return this.database.read((sql) => {
      const { id } = requireScope(sql, scope);
      const last = sql.get<{ seq_start: number }>(
        `SELECT seq_start FROM timeline_rows WHERE ${ACTIVE} ` +
          "AND item_type = 'assistant_message' ORDER BY seq_start DESC LIMIT 1",
        id,
      );
      if (!last) return null;
      let next = readRow(sql, id, last.seq_start);
      const chunks = [itemText(next.item)];
      for (const record of sql.iterate<RowRecord>(
        `SELECT seq_start, item_type, row FROM timeline_rows WHERE ${ACTIVE} ` +
          "AND seq_start < ? ORDER BY seq_start DESC",
        id,
        last.seq_start,
      )) {
        if (record.item_type !== "assistant_message") break;
        const row = withText(sql, id, parseRow(record));
        if (!continuesAssistantMessage(row, next)) break;
        chunks.push(itemText(row.item));
        next = row;
      }
      return chunks.toReversed().join("");
    });
  }

  /** Retired rows, oldest retirement first. Not part of the backend contract; tests read it. */
  retiredRows(scope: TimelineScope): ProjectedTimelineRow[] {
    return this.database.read((sql) => {
      const { id } = requireScope(sql, scope);
      return sql
        .all<RowRecord>(
          "SELECT seq_start, item_type, row FROM timeline_rows " +
            "WHERE scope_id = ? AND retired_by IS NOT NULL ORDER BY retired_by, seq_start",
          id,
        )
        .map((record) => withText(sql, id, parseRow(record)));
    });
  }
}

function describe(record: ScopeRecord): TimelineHead {
  return {
    epoch: record.epoch,
    seq: record.next_seq - 1,
    size: record.active_count,
    retirementCount: record.retirement_count,
    rewind: record.rewind ? (JSON.parse(record.rewind) as TimelineRewindIntent) : null,
  };
}

function toChild(subagentId: string, record: ScopeRecord): TimelineChild {
  return {
    subagentId,
    descriptor: record.descriptor
      ? (JSON.parse(record.descriptor) as ProviderSubagentDescriptor)
      : null,
    retired: record.child_retired === 1,
  };
}

function findScope(sql: ReadSql, scope: TimelineScope): ScopeRecord | undefined {
  return scope.subagentId === undefined
    ? sql.get<ScopeRecord>(
        `SELECT ${SCOPE_COLUMNS} FROM timeline_scopes WHERE agent_id = ? AND subagent_id IS NULL`,
        scope.agentId,
      )
    : sql.get<ScopeRecord>(
        `SELECT ${SCOPE_COLUMNS} FROM timeline_scopes WHERE agent_id = ? AND subagent_id = ?`,
        scope.agentId,
        scope.subagentId,
      );
}

function requireScope(sql: ReadSql, scope: TimelineScope): ScopeRecord {
  const record = findScope(sql, scope);
  if (!record) throw new UnknownTimelineError(scope);
  return record;
}

function listChildren(sql: ReadSql, agentId: string): TimelineChild[] {
  return sql
    .all<ScopeRecord & { subagent_id: string }>(
      `SELECT ${SCOPE_COLUMNS}, subagent_id FROM timeline_scopes ` +
        "WHERE agent_id = ? AND subagent_id IS NOT NULL",
      agentId,
    )
    .map((record) => toChild(record.subagent_id, record));
}

/** Replaces the scope's history, leaving a root's children as they are. */
function createScope(sql: WriteSql, scope: TimelineScope, seed: TimelineSeed): ScopeRecord {
  const existing = findScope(sql, scope);
  if (existing) sql.run("DELETE FROM timeline_scopes WHERE id = ?", existing.id);
  const timestamp = seed.timestamp ?? new Date().toISOString();
  const startSeq = seed.nextSeq ?? 1;
  const sourceRows = seed.rows?.length
    ? seed.rows.map((row) => ({ ...row }))
    : (seed.entries ?? []).map((entry, index) =>
        buildSourceRow(entry, startSeq + index, timestamp),
      );
  const nextSeq = sourceRows.reduce((next, row) => Math.max(next, row.seq + 1), startSeq);
  // A seed is already in memory; projecting it there reuses the projection's seeding rules.
  const rows = new TimelineProjection(sourceRows).getRows();
  const record: ScopeRecord = {
    id: 0,
    epoch: seed.epoch ?? randomUUID(),
    next_seq: nextSeq,
    min_seq: rows[0]?.seqStart ?? 0,
    active_count: rows.length,
    active_max_seq_end: 0,
    retirement_count: 0,
    rewind: null,
    descriptor: null,
    child_retired: 0,
  };
  record.id = sql.get<{ id: number }>(
    "INSERT INTO timeline_scopes (agent_id, subagent_id, epoch, next_seq, min_seq, " +
      "active_count, active_max_seq_end, retirement_count) VALUES (?, ?, ?, ?, ?, ?, 0, 0) " +
      "RETURNING id",
    scope.agentId,
    scope.subagentId ?? null,
    record.epoch,
    record.next_seq,
    record.min_seq,
    record.active_count,
  )!.id;
  const liveIdentityAt = new Map<string, number>();
  for (const row of rows) {
    const identity = timelineItemIdentity(row.item);
    if (identity !== null) liveIdentityAt.set(identity, row.seqStart);
  }
  const ranges: (TimelineSeqRange & { rowSeqStart: number })[] = [];
  for (const row of rows) {
    const identity = timelineItemIdentity(row.item);
    insertRow(sql, record.id, row, {
      spanStart: record.active_max_seq_end < row.seqStart,
      identityLive: identity !== null && liveIdentityAt.get(identity) === row.seqStart,
    });
    if (isTextItemType(row.item.type)) insertText(sql, record.id, row.seqStart, row.seqStart, row);
    record.active_max_seq_end = Math.max(record.active_max_seq_end, row.seqEnd);
    for (const range of row.sourceSeqRanges) ranges.push({ ...range, rowSeqStart: row.seqStart });
  }
  ranges.sort((left, right) => left.startSeq - right.startSeq);
  for (const range of ranges) {
    insertSourceRange(sql, record.id, range.startSeq, range.endSeq, range.rowSeqStart);
  }
  saveScopeCounters(sql, record);
  return record;
}

/** Folds one source row into the stored projection, mirroring `TimelineProjection.append`. */
function foldSourceRow(sql: WriteSql, record: ScopeRecord, row: AgentTimelineRow): void {
  const identity = timelineItemIdentity(row.item);
  const identityRecord = identity === null ? undefined : findIdentityRow(sql, record.id, identity);
  if (identityRecord) {
    const fold = foldTimelineRow({
      row,
      identityRow: parseRow(identityRecord),
      lastRow: undefined,
    });
    if (fold.kind === "identity") {
      saveRow(sql, record.id, fold.row);
      // Rows the longer coverage now reaches no longer start a span.
      sql.run(
        `UPDATE timeline_rows SET span_start = 0 WHERE ${ACTIVE} AND span_start = 1 ` +
          "AND seq_start > ? AND seq_start <= ?",
        record.id,
        fold.row.seqStart,
        fold.row.seqEnd,
      );
      coverSourceSeq(sql, record, row.seq, fold.row);
      return;
    }
  }
  const lastRow = isTextItemType(row.item.type) ? lastActiveTextRow(sql, record.id) : undefined;
  const fold = foldTimelineRow({ row, identityRow: undefined, lastRow });
  if (fold.kind === "adjacent") {
    // `lastRow` has no text, so the merged text is this chunk alone.
    insertText(sql, record.id, fold.row.seqStart, row.seq, fold.row);
    saveRow(sql, record.id, fold.row);
    coverSourceSeq(sql, record, row.seq, fold.row);
    return;
  }
  if (identity !== null) {
    sql.run(
      "UPDATE timeline_rows SET identity_live = 0 " +
        "WHERE scope_id = ? AND identity = ? AND identity_live = 1",
      record.id,
      identity,
    );
  }
  insertRow(sql, record.id, fold.row, {
    spanStart: record.active_max_seq_end < fold.row.seqStart,
    identityLive: identity !== null,
  });
  if (isTextItemType(fold.row.item.type)) {
    insertText(sql, record.id, fold.row.seqStart, row.seq, fold.row);
  }
  record.active_count += 1;
  coverSourceSeq(sql, record, row.seq, fold.row);
}

/** Records that `seq` is covered by `row`, extending the last source range when contiguous. */
function coverSourceSeq(
  sql: WriteSql,
  record: ScopeRecord,
  seq: number,
  row: ProjectedTimelineRow,
): void {
  record.active_max_seq_end = Math.max(record.active_max_seq_end, row.seqEnd);
  const last = lastSourceRange(sql, record.id);
  if (last && last.row_seq_start === row.seqStart && last.end_seq + 1 === seq) {
    sql.run(
      "UPDATE timeline_source_ranges SET end_seq = ? WHERE scope_id = ? AND start_seq = ?",
      seq,
      record.id,
      last.start_seq,
    );
    return;
  }
  insertSourceRange(sql, record.id, seq, seq, row.seqStart);
}

function lastSourceRange(sql: ReadSql, scopeId: number): SourceRangeRecord | undefined {
  return sql.get<SourceRangeRecord>(
    "SELECT start_seq, end_seq, row_seq_start FROM timeline_source_ranges " +
      "WHERE scope_id = ? ORDER BY start_seq DESC LIMIT 1",
    scopeId,
  );
}

function insertSourceRange(
  sql: WriteSql,
  scopeId: number,
  startSeq: number,
  endSeq: number,
  rowSeqStart: number | null,
): void {
  sql.run(
    "INSERT INTO timeline_source_ranges (scope_id, start_seq, end_seq, row_seq_start) " +
      "VALUES (?, ?, ?, ?)",
    scopeId,
    startSeq,
    endSeq,
    rowSeqStart,
  );
}

function saveScopeCounters(sql: WriteSql, record: ScopeRecord): void {
  sql.run(
    "UPDATE timeline_scopes SET next_seq = ?, min_seq = ?, active_count = ?, " +
      "active_max_seq_end = ?, retirement_count = ? WHERE id = ?",
    record.next_seq,
    record.min_seq,
    record.active_count,
    record.active_max_seq_end,
    record.retirement_count,
    record.id,
  );
}

/** The highest `seq_end` of the active rows: the end of the last span. */
function activeMaxSeqEnd(sql: ReadSql, scopeId: number): number {
  const lastSpan = sql.get<{ seq_start: number }>(
    `SELECT seq_start FROM timeline_rows WHERE ${ACTIVE} AND span_start = 1 ` +
      "ORDER BY seq_start DESC LIMIT 1",
    scopeId,
  );
  if (!lastSpan) return 0;
  return sql.get<{ max: number }>(
    `SELECT MAX(seq_end) AS max FROM timeline_rows WHERE ${ACTIVE} AND seq_start >= ?`,
    scopeId,
    lastSpan.seq_start,
  )!.max;
}

/** The row JSON, with a streamed text row's text left out; the text lives in `timeline_text`. */
function encodeRow(row: ProjectedTimelineRow): string {
  if (!isTextItemType(row.item.type)) return JSON.stringify(row);
  return JSON.stringify({ ...row, item: { ...row.item, text: "" } });
}

function itemText(item: AgentTimelineItem): string {
  return item.type === "assistant_message" || item.type === "reasoning" ? item.text : "";
}

function insertRow(
  sql: WriteSql,
  scopeId: number,
  row: ProjectedTimelineRow,
  flags: { spanStart: boolean; identityLive: boolean },
): void {
  sql.run(
    "INSERT INTO timeline_rows (scope_id, seq_start, seq_end, retired_by, span_start, identity, " +
      "identity_live, turn_id, turn_trigger, item_type, client_message_id, row) " +
      "VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
    scopeId,
    row.seqStart,
    row.seqEnd,
    flags.spanStart ? 1 : 0,
    timelineItemIdentity(row.item),
    flags.identityLive ? 1 : 0,
    row.turnId ?? null,
    isTimelineTurnTrigger(row.item) ? 1 : 0,
    row.item.type,
    row.item.type === "user_message" ? (row.item.clientMessageId ?? null) : null,
    encodeRow(row),
  );
}

/** Rewrites an existing row's payload and the columns an update can change. */
function saveRow(sql: WriteSql, scopeId: number, row: ProjectedTimelineRow): void {
  sql.run(
    "UPDATE timeline_rows SET seq_end = ?, turn_id = ?, turn_trigger = ?, row = ? " +
      "WHERE scope_id = ? AND seq_start = ?",
    row.seqEnd,
    row.turnId ?? null,
    isTimelineTurnTrigger(row.item) ? 1 : 0,
    encodeRow(row),
    scopeId,
    row.seqStart,
  );
}

function insertText(
  sql: WriteSql,
  scopeId: number,
  seqStart: number,
  seq: number,
  row: ProjectedTimelineRow,
): void {
  sql.run(
    "INSERT INTO timeline_text (scope_id, seq_start, seq, text_json) VALUES (?, ?, ?, ?)",
    scopeId,
    seqStart,
    seq,
    JSON.stringify(itemText(row.item)),
  );
}

function parseRow(record: Pick<RowRecord, "row">): ProjectedTimelineRow {
  return JSON.parse(record.row) as ProjectedTimelineRow;
}

/** Fills a parsed text row's text from its chunks. */
function withText(sql: ReadSql, scopeId: number, row: ProjectedTimelineRow): ProjectedTimelineRow {
  if (row.item.type !== "assistant_message" && row.item.type !== "reasoning") return row;
  const text = sql
    .all<{ text_json: string }>(
      "SELECT text_json FROM timeline_text WHERE scope_id = ? AND seq_start = ? ORDER BY seq",
      scopeId,
      row.seqStart,
    )
    .map((chunk) => JSON.parse(chunk.text_json) as string)
    .join("");
  return { ...row, item: { ...row.item, text } };
}

function readRow(sql: ReadSql, scopeId: number, seqStart: number): ProjectedTimelineRow {
  const record = sql.get<RowRecord>(
    "SELECT seq_start, item_type, row FROM timeline_rows WHERE scope_id = ? AND seq_start = ?",
    scopeId,
    seqStart,
  )!;
  return withText(sql, scopeId, parseRow(record));
}

/** Active rows anchored in `[fromSeq, beforeSeq)`, in display order. */
function readActiveRows(
  sql: ReadSql,
  scopeId: number,
  range: { fromSeq?: number; beforeSeq?: number },
): ProjectedTimelineRow[] {
  return sql
    .all<RowRecord>(
      `SELECT seq_start, item_type, row FROM timeline_rows WHERE ${ACTIVE} ` +
        "AND seq_start >= ? AND seq_start < ? ORDER BY seq_start",
      scopeId,
      range.fromSeq ?? Number.MIN_SAFE_INTEGER,
      range.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    )
    .map((record) => withText(sql, scopeId, parseRow(record)));
}

/** The last active row when it is a streamed text row, without its text. */
function lastActiveTextRow(sql: ReadSql, scopeId: number): ProjectedTimelineRow | undefined {
  // The payload of any other row type is not read.
  const last = sql.get<{ row: string | null }>(
    "SELECT CASE WHEN item_type IN ('assistant_message', 'reasoning') THEN row END AS row " +
      `FROM timeline_rows WHERE ${ACTIVE} ORDER BY seq_start DESC LIMIT 1`,
    scopeId,
  );
  return last?.row ? parseRow({ row: last.row }) : undefined;
}

function findIdentityRow(sql: ReadSql, scopeId: number, identity: string): RowRecord | undefined {
  return sql.get<RowRecord>(
    "SELECT seq_start, item_type, row FROM timeline_rows " +
      "WHERE scope_id = ? AND identity = ? AND identity_live = 1",
    scopeId,
    identity,
  );
}

function findSubmittedPromptRecord(
  sql: ReadSql,
  scopeId: number,
  clientMessageId: string,
): RowRecord | undefined {
  return sql.get<RowRecord>(
    "SELECT seq_start, item_type, row FROM timeline_rows " +
      "WHERE scope_id = ? AND client_message_id = ? AND retired_by IS NULL " +
      "ORDER BY seq_start LIMIT 1",
    scopeId,
    clientMessageId,
  );
}

function hasActiveTurn(sql: ReadSql, scopeId: number, turnId: string): boolean {
  return (
    sql.get(
      `SELECT 1 FROM timeline_rows WHERE ${ACTIVE} AND turn_id = ? LIMIT 1`,
      scopeId,
      turnId,
    ) !== undefined
  );
}

function hasRetiredKey(sql: ReadSql, scopeId: number, kind: string, key: string): boolean {
  return (
    sql.get(
      "SELECT 1 FROM timeline_retired_keys WHERE scope_id = ? AND kind = ? AND key = ?",
      scopeId,
      kind,
      key,
    ) !== undefined
  );
}

function addRetiredKey(sql: WriteSql, scopeId: number, kind: string, key: string): void {
  sql.run(
    "INSERT OR IGNORE INTO timeline_retired_keys (scope_id, kind, key) VALUES (?, ?, ?)",
    scopeId,
    kind,
    key,
  );
}

function continuesShape(previous: RowShape, next: RowShape): boolean {
  return continuesTimelineTurn(
    previous.turn_id ?? undefined,
    next.turn_id ?? undefined,
    next.turn_trigger === 1,
  );
}

/**
 * The row a completed turn's metrics go on: the turn's last assistant message, else its last row
 * when that row is a tool call. Mirrors `TimelineProjection.stampTurnMetrics`.
 */
function turnFooterSeq(sql: ReadSql, scopeId: number, turnId: string | undefined): number | null {
  const tail = sql.get<RowShape>(
    `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} ORDER BY seq_start DESC LIMIT 1`,
    scopeId,
  );
  if (!tail) return null;
  let last: RowShape | undefined = tail;
  if (turnId !== undefined) {
    last =
      sql.get<RowShape>(
        `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND turn_id = ? ` +
          "ORDER BY seq_start DESC LIMIT 1",
        scopeId,
        turnId,
      ) ?? (tail.turn_id === null ? tail : undefined);
  }
  if (!last) return null;
  let next: RowShape | undefined;
  for (const row of sql.iterate<RowShape>(
    `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND seq_start <= ? ` +
      "ORDER BY seq_start DESC",
    scopeId,
    last.seq_start,
  )) {
    if (next && !continuesShape(row, next)) break;
    if (row.item_type === "assistant_message") return row.seq_start;
    next = row;
  }
  return last.item_type === "tool_call" ? last.seq_start : null;
}

/**
 * Page selection over the stored projection. It mirrors `TimelineProjection.selectPage` with
 * row anchors in place of row indexes, and reads only the rows the page returns plus the bounded
 * walks the page rules need.
 */
class StoredPageSelection {
  private readonly scopeId: number;

  constructor(
    private readonly sql: ReadSql,
    private readonly record: ScopeRecord,
  ) {
    this.scopeId = record.id;
  }

  select(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const hasRows = this.record.active_count > 0;
    if (!hasRows && lastSourceRange(this.sql, this.scopeId)) {
      // Every row is retired. Forward pages still advance; a tail covers the whole window.
      if (input.direction === "after") return this.selectAfter(input);
      if (input.direction === "tail") {
        return {
          entries: [],
          startSeq: input.bounds.minSeq,
          endSeq: input.bounds.maxSeq,
          hasOlder: false,
          hasNewer: false,
          retirements: this.retirementsInSpan(input.bounds.minSeq, input.bounds.maxSeq),
        };
      }
    }
    if (!hasRows) {
      const cursor =
        input.cursorSeq ??
        (input.direction === "before" ? input.bounds.maxSeq + 1 : input.bounds.minSeq - 1);
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder:
          input.direction === "after"
            ? cursor >= input.bounds.minSeq
            : input.direction === "before" && cursor > input.bounds.minSeq,
        hasNewer:
          input.direction === "after"
            ? cursor < input.bounds.maxSeq
            : input.direction === "before" && cursor <= input.bounds.maxSeq,
        retirements: [],
      };
    }
    switch (input.direction) {
      case "tail":
        return this.selectTail(input);
      case "after":
        return this.selectAfter(input);
      case "before":
        return this.selectBefore(input);
    }
  }

  private selectTail(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const limit = Math.max(0, Math.floor(input.limit ?? 0));
    const requested = (limit > 0 && this.nthActiveFromEnd(limit)) || this.firstActive();
    const covered = this.spanStartAtOrBefore(requested);
    const start = input.wholeTurns ? this.wholeTurnWindowStart(covered) : covered;
    return {
      entries: readActiveRows(this.sql, this.scopeId, { fromSeq: start }),
      startSeq: start,
      endSeq: input.bounds.maxSeq,
      hasOlder: this.hasActiveAnchorIn(Number.MIN_SAFE_INTEGER, start),
      hasNewer: false,
      retirements: this.retirementsInSpan(start, input.bounds.maxSeq),
    };
  }

  private selectAfter(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const startSeq = Math.max(
      input.bounds.minSeq,
      (input.cursorSeq ?? input.bounds.minSeq - 1) + 1,
    );
    const limit = Math.max(0, Math.floor(input.limit ?? 0));
    const anchors = new Set<number>();
    const covered: TimelineSeqRange[] = [];
    const retirements: TimelineRetirement[] = [];
    // Ranges are disjoint and ordered: start from the one that may contain `startSeq`.
    const first =
      this.sql.get<{ start_seq: number }>(
        "SELECT start_seq FROM timeline_source_ranges WHERE scope_id = ? AND start_seq <= ? " +
          "ORDER BY start_seq DESC LIMIT 1",
        this.scopeId,
        startSeq,
      )?.start_seq ?? Number.MIN_SAFE_INTEGER;
    for (const range of this.sql.iterate<SourceRangeRecord>(
      "SELECT start_seq, end_seq, row_seq_start FROM timeline_source_ranges " +
        "WHERE scope_id = ? AND start_seq >= ? ORDER BY start_seq",
      this.scopeId,
      first,
    )) {
      if (range.end_seq < startSeq) continue;
      if (range.start_seq > input.bounds.maxSeq) break;
      if (range.row_seq_start !== null) {
        anchors.add(range.row_seq_start);
      } else {
        covered.push({ startSeq: Math.max(range.start_seq, startSeq), endSeq: range.end_seq });
        const retirement = this.sql.get<RetirementRecord>(
          "SELECT seq, retire_from_seq FROM timeline_retirements WHERE scope_id = ? AND seq = ?",
          this.scopeId,
          range.start_seq,
        );
        if (retirement) {
          retirements.push({ seq: retirement.seq, retireFromSeq: retirement.retire_from_seq });
        }
      }
      // Each retirement counts toward the limit, so a page stays bounded however many it crosses.
      if (limit > 0 && anchors.size + retirements.length >= limit) break;
    }
    const entries = [...anchors]
      .sort((left, right) => left - right)
      .map((anchor) => readRow(this.sql, this.scopeId, anchor));
    const selected = selectProjectedEntriesAfter({
      entries,
      covered,
      startSeq,
      maxSeq: input.bounds.maxSeq,
      limit,
    });
    const endSeq = selected.endSeq;
    return {
      entries: selected.entries.map((entry) => entry as ProjectedTimelineRow),
      startSeq: endSeq === null ? null : startSeq,
      endSeq,
      hasOlder: startSeq > input.bounds.minSeq,
      hasNewer: endSeq !== null && endSeq < input.bounds.maxSeq,
      retirements:
        endSeq === null
          ? []
          : this.coalesce(retirements.filter((retirement) => retirement.seq <= endSeq)),
    };
  }

  private selectBefore(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const endSeq = Math.min(input.bounds.maxSeq, (input.cursorSeq ?? input.bounds.maxSeq + 1) - 1);
    if (endSeq < input.bounds.minSeq) {
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder: false,
        hasNewer: true,
        retirements: [],
      };
    }
    const limit = Math.max(0, Math.floor(input.limit ?? 0));
    const requested = (limit > 0 && this.nthActiveFromEnd(limit, endSeq)) || this.firstActive();
    const start = input.wholeTurns ? this.wholeTurnWindowStart(requested) : requested;
    // The first active row after the page; undefined when the page reaches the end.
    let after = this.sql.get<RowShape>(
      `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND seq_start > ? ` +
        "ORDER BY seq_start LIMIT 1",
      this.scopeId,
      endSeq,
    );
    const lastInPage = this.sql.get<RowShape>(
      `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND seq_start <= ? ` +
        "ORDER BY seq_start DESC LIMIT 1",
      this.scopeId,
      endSeq,
    );
    if (input.wholeTurns && after && lastInPage) {
      // Choose the window before extending the right edge, so a prompt jump cannot lose its
      // target when the next turn is arbitrarily large.
      let previous = lastInPage;
      after = undefined;
      for (const row of this.sql.iterate<RowShape>(
        `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND seq_start > ? ` +
          "ORDER BY seq_start",
        this.scopeId,
        endSeq,
      )) {
        if (!continuesShape(previous, row)) {
          after = row;
          break;
        }
        previous = row;
      }
    }
    let selectedEnd = endSeq;
    if (input.wholeTurns) {
      selectedEnd = after ? after.seq_start - 1 : input.bounds.maxSeq;
    }
    return {
      entries: readActiveRows(this.sql, this.scopeId, {
        fromSeq: start,
        beforeSeq: after?.seq_start,
      }),
      startSeq: start,
      endSeq: selectedEnd,
      hasOlder: this.hasActiveAnchorIn(Number.MIN_SAFE_INTEGER, start),
      hasNewer: selectedEnd < input.bounds.maxSeq,
      retirements: this.retirementsInSpan(start, selectedEnd),
    };
  }

  /** Extends a window start back to whole turns and whole coverage spans. */
  private wholeTurnWindowStart(requested: number): number {
    let start = requested;
    for (;;) {
      let next = this.shape(start);
      for (const row of this.sql.iterate<RowShape>(
        `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE ${ACTIVE} AND seq_start < ? ` +
          "ORDER BY seq_start DESC",
        this.scopeId,
        start,
      )) {
        if (!continuesShape(row, next)) break;
        start = row.seq_start;
        next = row;
      }
      // Source coverage can pull in an earlier tool and therefore its entire run.
      const covered = this.spanStartAtOrBefore(start);
      if (covered === start) return start;
      start = covered;
    }
  }

  private shape(seqStart: number): RowShape {
    return this.sql.get<RowShape>(
      `SELECT ${SHAPE_COLUMNS} FROM timeline_rows WHERE scope_id = ? AND seq_start = ?`,
      this.scopeId,
      seqStart,
    )!;
  }

  private firstActive(): number {
    return this.sql.get<{ seq_start: number }>(
      `SELECT seq_start FROM timeline_rows WHERE ${ACTIVE} ORDER BY seq_start LIMIT 1`,
      this.scopeId,
    )!.seq_start;
  }

  /** The anchor of the `n`th active row from the end, among rows anchored at or before `atOrBefore`. */
  private nthActiveFromEnd(n: number, atOrBefore = Number.MAX_SAFE_INTEGER): number | undefined {
    return this.sql.get<{ seq_start: number }>(
      `SELECT seq_start FROM timeline_rows WHERE ${ACTIVE} AND seq_start <= ? ` +
        "ORDER BY seq_start DESC LIMIT 1 OFFSET ?",
      this.scopeId,
      atOrBefore,
      n - 1,
    )?.seq_start;
  }

  private spanStartAtOrBefore(seqStart: number): number {
    return this.sql.get<{ seq_start: number }>(
      `SELECT seq_start FROM timeline_rows WHERE ${ACTIVE} AND span_start = 1 ` +
        "AND seq_start <= ? ORDER BY seq_start DESC LIMIT 1",
      this.scopeId,
      seqStart,
    )!.seq_start;
  }

  private hasActiveAnchorIn(startSeq: number, endSeq: number): boolean {
    return (
      this.sql.get(
        `SELECT 1 FROM timeline_rows WHERE ${ACTIVE} AND seq_start >= ? AND seq_start < ? LIMIT 1`,
        this.scopeId,
        startSeq,
        endSeq,
      ) !== undefined
    );
  }

  private retirementsInSpan(startSeq: number, endSeq: number): TimelineRetirement[] {
    return this.coalesce(
      this.sql
        .all<RetirementRecord>(
          "SELECT seq, retire_from_seq FROM timeline_retirements " +
            "WHERE scope_id = ? AND seq >= ? AND seq <= ? ORDER BY seq",
          this.scopeId,
          startSeq,
          endSeq,
        )
        .map((record) => ({ seq: record.seq, retireFromSeq: record.retire_from_seq })),
    );
  }

  private coalesce(retirements: readonly TimelineRetirement[]): TimelineRetirement[] {
    return coalesceTimelineRetirements(retirements, (startSeq, endSeq) =>
      this.hasActiveAnchorIn(startSeq, endSeq),
    );
  }
}
