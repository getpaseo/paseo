import { describe, expect, it } from "vitest";
import type { AgentTimelineItem, ProviderSwitchTimelineItem } from "../agent-sdk-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import {
  DatabaseSchemaTooNewError,
  openDaemonDatabase,
  type DaemonDatabase,
  type SchemaModule,
} from "../../database/index.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { nextTestDatabasePath } from "../../test-utils/test-database-path.js";
import {
  AgentTimeline,
  TimelineProviderSwitchPendingError,
  TimelineRewindPendingError,
  TimelineRewindSegmentBoundaryError,
  createStoredAgentTimeline,
  timelineSchema,
  type TimelineEntry,
  type TimelineProviderSwitchIntent,
  type TimelineScope,
} from "./index.js";
import { SqliteTimelineBackend } from "./internal/sqlite-backend.js";
import { openTestTimelineDatabase, TIMELINE_CONTRACT_BACKENDS } from "./testing.js";

const scope: TimelineScope = { agentId: "agent-switch" };
const TS = "2026-11-25T10:00:00.000Z";

function switchMarker(fromProvider = "claude", toProvider = "codex"): ProviderSwitchTimelineItem {
  return {
    type: "provider_switch",
    fromProvider,
    toProvider,
    fromModel: "claude-sonnet-4-6",
    toModel: "gpt-5.4",
    fromSessionId: "claude-sess-1",
    toSessionId: null,
    context: {
      includedItems: 2,
      truncated: false,
      charCount: 120,
      budgetChars: 100_000,
    },
  };
}

function switchIntent(
  overrides: Partial<TimelineProviderSwitchIntent> = {},
): Omit<TimelineProviderSwitchIntent, "id" | "phase"> {
  return {
    messageId: "msg-switch-1",
    fromProvider: "claude",
    fromPersistence: { provider: "claude", sessionId: "claude-sess-1" },
    fromModel: "claude-sonnet-4-6",
    toProvider: "codex",
    toConfig: { model: "gpt-5.4", modeId: "auto" },
    targetPersistence: null,
    context: {
      includedItems: 2,
      truncated: false,
      charCount: 120,
      budgetChars: 100_000,
    },
    ...overrides,
  };
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

function childDescriptor(
  id: string,
  provider: string,
  toolCallId: string,
): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: scope.agentId,
    parentSubagentId: null,
    provider,
    title: id,
    description: null,
    status: "completed",
    createdAt: TS,
    updatedAt: TS,
    toolCallId,
    cwd: null,
    subtitle: null,
  };
}

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

describe.each(TIMELINE_CONTRACT_BACKENDS)(
  "provider switching timeline contract ($name)",
  ({ create }) => {
    it("commits switch marker, scopes rewind to active segment, and protects pre-switch history on null retainedMessageId", async () => {
      const timeline = new AgentTimeline(create());
      await timeline.create(scope, { epoch: "ep-1" });

      // Segment 1 (Claude)
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t1",
        item: {
          type: "user_message",
          text: "First Claude prompt",
          messageId: "c1",
          clientMessageId: "c1",
        },
      });
      await timeline.attachProviderMessageId(scope, "c1", "claude-p1");
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t1",
        item: { type: "assistant_message", text: "Claude answer" },
      });

      const intent = await timeline.beginProviderSwitch(scope, switchIntent());
      expect((await timeline.describe(scope))?.providerSwitch?.phase).toBe("preparing");

      // Rewind refused while switch intent is open
      await expect(timeline.beginRewind(scope, "c1")).rejects.toThrow(
        TimelineProviderSwitchPendingError,
      );

      const committed = await timeline.commitProviderSwitch(scope, intent.id, {
        markerEntry: { provider: "codex", item: switchMarker("claude", "codex") },
      });
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") return;
      const markerSeq = committed.row.seq;

      const headAfterCommit = await timeline.describe(scope);
      expect(headAfterCommit?.activeSegmentStartSeq).toBe(markerSeq);
      expect(headAfterCommit?.providerSwitch?.phase).toBe("marker_committed");
      expect(headAfterCommit?.providerSwitch?.markerSeq).toBe(markerSeq);

      await timeline.completeProviderSwitch(scope, intent.id);
      expect((await timeline.describe(scope))?.providerSwitch).toBeNull();

      // Segment 2 (Codex)
      await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t1",
        providerPromptText:
          "<chat-history-summary>...</chat-history-summary>\n\nFirst Codex prompt",
        item: {
          type: "user_message",
          text: "First Codex prompt",
          messageId: "c2",
          clientMessageId: "c2",
        },
      });
      await timeline.attachProviderMessageId(scope, "c2", "codex-p1", {
        providerPromptText:
          "<chat-history-summary>...</chat-history-summary>\n\nFirst Codex prompt",
      });
      await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t1",
        item: { type: "assistant_message", text: "Codex answer" },
      });

      const page = await timeline.fetch(scope, { direction: "tail", limit: 20 });
      expect(page.activeSegmentStartSeq).toBe(markerSeq);

      // Rewinding pre-switch prompt is refused
      await expect(timeline.beginRewind(scope, "c1")).rejects.toThrow(
        TimelineRewindSegmentBoundaryError,
      );

      // Rewinding first post-switch prompt with retainedMessageId: null retires ONLY segment 2
      const rewind = await timeline.beginRewind(scope, "c2");
      await timeline.recordRewindCut(scope, rewind.id, { kind: "after", retainedMessageId: null });
      const completion = await timeline.completeRewind(scope, rewind.id);
      expect(completion.kind).toBe("retired");
      if (completion.kind !== "retired") return;
      expect(completion.retirement.retireFromSeq).toBeGreaterThan(markerSeq);

      const remaining = await timeline.readRows(scope);
      expect(remaining.map((r) => r.item.type)).toEqual([
        "user_message",
        "assistant_message",
        "provider_switch",
      ]);
    });

    it("judges open rewind and reconciles provider history strictly within the active segment using providerPromptText", async () => {
      const timeline = new AgentTimeline(create());
      await timeline.create(scope, { epoch: "ep-1" });

      // Segment 1 (Claude)
      await timeline.ingest(scope, {
        provider: "claude",
        item: {
          type: "user_message",
          text: "Claude prompt",
          messageId: "c1",
          clientMessageId: "c1",
        },
      });
      await timeline.attachProviderMessageId(scope, "c1", "claude-p1");

      const intent = await timeline.beginProviderSwitch(scope, switchIntent());
      await timeline.commitProviderSwitch(scope, intent.id, {
        markerEntry: { provider: "codex", item: switchMarker("claude", "codex") },
      });
      await timeline.completeProviderSwitch(scope, intent.id);

      // Segment 2 (Codex) with attachment-bearing handoff prompt + second prompt
      const handoffRendered =
        "<chat-history-summary>\nctx\n</chat-history-summary>\n\nSwitch prompt";
      await timeline.ingest(scope, {
        provider: "codex",
        providerPromptText: handoffRendered,
        item: {
          type: "user_message",
          text: "Switch prompt",
          messageId: "c2",
          clientMessageId: "c2",
        },
      });
      await timeline.attachProviderMessageId(scope, "c2", "codex-p1", {
        providerPromptText: handoffRendered,
      });
      await timeline.ingest(scope, {
        provider: "codex",
        item: { type: "assistant_message", text: "Codex reply 1" },
      });
      await timeline.ingest(scope, {
        provider: "codex",
        item: { type: "user_message", text: "Follow up", messageId: "c3", clientMessageId: "c3" },
      });
      await timeline.attachProviderMessageId(scope, "c3", "codex-p2");

      // Reconcile against Codex native replay (which only has codex-p1 and codex-p2, plus a new turn)
      const providerReplay: TimelineEntry[] = [
        {
          provider: "codex",
          item: { type: "user_message", text: handoffRendered, messageId: "codex-p1" },
        },
        { provider: "codex", item: { type: "assistant_message", text: "Codex reply 1" } },
        {
          provider: "codex",
          item: { type: "user_message", text: "Follow up", messageId: "codex-p2" },
        },
        {
          provider: "codex",
          item: { type: "user_message", text: "External turn", messageId: "codex-p3" },
        },
        { provider: "codex", item: { type: "assistant_message", text: "External reply" } },
      ];
      const reconciled = await timeline.reconcileProviderHistory(scope, providerReplay);
      expect(reconciled.kind).toBe("appended");

      // Judge open rewind on codex-p2 using only Codex's native prompt IDs
      const rw = await timeline.beginRewind(scope, "c3");
      const unchanged = await timeline.judgeRewind(scope, rw.id, [
        "codex-p1",
        "codex-p2",
        "codex-p3",
      ]);
      expect(unchanged).toEqual({ kind: "unchanged" });
      const applied = await timeline.judgeRewind(scope, rw.id, ["codex-p1"]);
      expect(applied).toEqual({
        kind: "applied",
        cut: { kind: "after", retainedMessageId: "codex-p1" },
      });

      // Opening a provider switch while rewind is open is refused
      await expect(
        timeline.beginProviderSwitch(scope, switchIntent({ messageId: "msg-2" })),
      ).rejects.toThrow(TimelineRewindPendingError);
    });

    it("isolates tool call identities, retired keys, turn metrics, and provider children across segments", async () => {
      const timeline = new AgentTimeline(create());
      await timeline.create(scope, { epoch: "ep-1" });

      // Segment 1 (Claude) with tool call_1 (active) and turn t1 + tool call_2 (retired)
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t1",
        item: { type: "user_message", text: "Claude 1", messageId: "c1", clientMessageId: "c1" },
      });
      await timeline.attachProviderMessageId(scope, "c1", "claude-p1");
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t1",
        item: tool("call_shared", "completed", "claude tool"),
      });
      await timeline.recordChild({ agentId: scope.agentId, subagentId: "claude-child-1" }, () =>
        childDescriptor("claude-child-1", "claude", "call_shared"),
      );
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t1",
        item: { type: "assistant_message", text: "Claude 1 reply" },
      });

      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t_retired",
        item: { type: "user_message", text: "Claude 2", messageId: "c2", clientMessageId: "c2" },
      });
      await timeline.attachProviderMessageId(scope, "c2", "claude-p2");
      await timeline.ingest(scope, {
        provider: "claude",
        turnId: "t_retired",
        item: tool("call_retired", "completed"),
      });
      // Retire Claude 2 so call_retired and t_retired are in retired keys
      const rw1 = await timeline.beginRewind(scope, "c2");
      await timeline.recordRewindCut(scope, rw1.id, { kind: "at_target" });
      await timeline.completeRewind(scope, rw1.id);

      // Switch to Codex
      const intent = await timeline.beginProviderSwitch(scope, switchIntent());
      await timeline.commitProviderSwitch(scope, intent.id, {
        markerEntry: { provider: "codex", item: switchMarker("claude", "codex") },
      });
      await timeline.completeProviderSwitch(scope, intent.id);

      // Segment 2 (Codex) reuses turnId "t_retired", callId "call_retired", and callId "call_shared"
      await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t_retired",
        item: { type: "user_message", text: "Codex 1", messageId: "c3", clientMessageId: "c3" },
      });
      await timeline.attachProviderMessageId(scope, "c3", "codex-p1");
      const reusedRetired = await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t_retired",
        item: tool("call_retired", "completed", "codex reused retired"),
      });
      expect(reusedRetired.kind).toBe("recorded");

      const reusedActive = await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t1",
        item: tool("call_shared", "completed", "codex tool"),
      });
      expect(reusedActive.kind).toBe("recorded");
      await timeline.ingest(scope, {
        provider: "codex",
        turnId: "t1",
        item: { type: "assistant_message", text: "Codex reply" },
      });

      // Stamping turnMetrics for turnId "t1" stamps Codex's assistant reply, not Claude's
      const stamped = await timeline.stampTurnMetrics(scope, [{ label: "Tokens", value: "42" }], {
        turnId: "t1",
      });
      expect(stamped?.item).toEqual({ type: "assistant_message", text: "Codex reply" });

      // Both Claude's and Codex's call_shared rows exist separately
      const rows = await timeline.readRows(scope);
      const sharedTools = rows.filter(
        (row) => row.item.type === "tool_call" && row.item.callId === "call_shared",
      );
      expect(sharedTools).toHaveLength(2);

      // Rewinding Codex's turn with call_shared does NOT retire Claude's historical provider child
      const rw2 = await timeline.beginRewind(scope, "c3");
      await timeline.recordRewindCut(scope, rw2.id, { kind: "at_target" });
      await timeline.completeRewind(scope, rw2.id);
      const children = await timeline.listChildren(scope.agentId);
      expect(children).toEqual([
        expect.objectContaining({ subagentId: "claude-child-1", retired: false }),
      ]);
    });
  },
);

describe("SQLite timeline migration v2 and durability", () => {
  it("migrates a v1 database in place and refuses downgrade to a v1 reader", async () => {
    const file = nextTestDatabasePath();
    const v1Schema: SchemaModule = {
      name: "timeline",
      migrations: [timelineSchema.migrations[0]!],
    };
    const dbV1 = openDaemonDatabase({
      path: file,
      modules: [v1Schema],
      logger: createTestLogger(),
    });
    // Seed a v1 scope row directly
    dbV1.write((sql) => {
      sql.run(
        "INSERT INTO timeline_scopes (agent_id, subagent_id, epoch, next_seq, min_seq, active_count, active_max_seq_end, retirement_count) VALUES (?, NULL, 'ep-v1', 1, 0, 0, 0, 0)",
        scope.agentId,
      );
    });
    dbV1.close();

    // Open with v2 schema — upgrades cleanly
    const dbV2 = openDaemonDatabase({
      path: file,
      modules: [timelineSchema],
      logger: createTestLogger(),
    });
    const timeline = createStoredAgentTimeline(dbV2);
    const head = await timeline.describe(scope);
    expect(head).toMatchObject({
      epoch: "ep-v1",
      activeSegmentStartSeq: 0,
      providerSwitch: null,
    });
    const intent = await timeline.beginProviderSwitch(scope, switchIntent());
    await timeline.commitProviderSwitch(scope, intent.id, {
      markerEntry: { provider: "codex", item: switchMarker() },
    });
    await timeline.close();
    dbV2.close();

    // Reopening with v2 preserves open intent + activeSegmentStartSeq
    const dbV2Reopen = openDaemonDatabase({
      path: file,
      modules: [timelineSchema],
      logger: createTestLogger(),
    });
    const reopened = createStoredAgentTimeline(dbV2Reopen);
    const reopenedHead = await reopened.describe(scope);
    expect(reopenedHead?.activeSegmentStartSeq).toBe(1);
    expect(reopenedHead?.providerSwitch?.phase).toBe("marker_committed");
    await reopened.close();
    dbV2Reopen.close();

    // Reopening with v1 reader refuses with DatabaseSchemaTooNewError
    expect(() =>
      openDaemonDatabase({ path: file, modules: [v1Schema], logger: createTestLogger() }),
    ).toThrow(DatabaseSchemaTooNewError);
  });

  it("rolls back commitProviderSwitch atomically if a statement fails mid-transaction", () => {
    const database = openTestTimelineDatabase();
    const backend = new SqliteTimelineBackend(database);
    backend.create(scope, { epoch: "ep-rollback" });
    backend.append(scope, [
      {
        provider: "claude",
        item: { type: "user_message", text: "hi", messageId: "m1" },
        timestamp: TS,
      },
    ]);
    const intent: TimelineProviderSwitchIntent = {
      id: "sw-1",
      phase: "preparing",
      ...switchIntent(),
    };
    backend.setProviderSwitch(scope, intent);
    const before = dumpTables(database);
    database.write((sql) => {
      sql.exec(
        "CREATE TRIGGER fail_switch BEFORE INSERT ON timeline_source_ranges " +
          "BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
    });
    expect(() =>
      backend.commitProviderSwitch(scope, {
        markerEntry: { provider: "codex", item: switchMarker(), timestamp: TS },
        nextIntent: { ...intent, phase: "marker_committed", markerSeq: 2 },
      }),
    ).toThrow(/disk full/);
    expect(dumpTables(database)).toEqual(before);
    database.close();
  });
});
