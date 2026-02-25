import { describe, expect, test } from "vitest";

import type { AgentTimelineRow } from "./agent-manager.js";
import {
  projectTimelineRows,
  selectTimelineWindowByProjectedLimit,
} from "./timeline-projection.js";

describe("projectTimelineRows", () => {
  test("merges adjacent assistant chunks in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "lo" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "user_message", text: "next" },
      },
    ];

    const projected = projectTimelineRows(rows, "codex", "projected");

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "Hello",
    });
    expect(projected[0]?.seqStart).toBe(1);
    expect(projected[0]?.seqEnd).toBe(2);
    expect(projected[0]?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 2 }]);
    expect(projected[0]?.collapsed).toContain("assistant_merge");
  });

  test("collapses tool lifecycle by callId and reports exact source seq ranges", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "working" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const projected = projectTimelineRows(rows, "codex", "projected");

    expect(projected).toHaveLength(2);
    const tool = projected[0];
    expect(tool?.item.type).toBe("tool_call");
    if (tool?.item.type === "tool_call") {
      expect(tool.item.status).toBe("completed");
      expect(tool.item.callId).toBe("call_1");
    }
    expect(tool?.sourceSeqRanges).toEqual([
      { startSeq: 1, endSeq: 1 },
      { startSeq: 3, endSeq: 3 },
    ]);
    expect(tool?.collapsed).toContain("tool_lifecycle");
  });

  test("returns canonical rows unchanged in canonical mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 10,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "A" },
      },
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "B" },
      },
    ];

    const projected = projectTimelineRows(rows, "codex", "canonical");

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual(rows[0]?.item);
    expect(projected[1]?.item).toEqual(rows[1]?.item);
    expect(projected[0]?.collapsed).toEqual([]);
    expect(projected[1]?.collapsed).toEqual([]);
  });
});

describe("selectTimelineWindowByProjectedLimit", () => {
  test("tail limit selects canonical rows for the latest projected entries", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.010Z",
        item: { type: "assistant_message", text: "lo" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.020Z",
        item: { type: "user_message", text: "next" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.030Z",
        item: { type: "assistant_message", text: "Wor" },
      },
      {
        seq: 5,
        timestamp: "2026-02-13T00:00:00.040Z",
        item: { type: "assistant_message", text: "ld" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "codex",
      direction: "tail",
      limit: 1,
    });

    expect(selected.minSeq).toBe(4);
    expect(selected.maxSeq).toBe(5);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([4, 5]);
    expect(selected.projectedEntries).toHaveLength(1);
    expect(selected.projectedEntries[0]?.item).toEqual({
      type: "assistant_message",
      text: "World",
    });
  });

  test("after limit selects canonical rows for the earliest projected entries", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 10,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "A" },
      },
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.010Z",
        item: { type: "assistant_message", text: "B" },
      },
      {
        seq: 12,
        timestamp: "2026-02-13T00:00:00.020Z",
        item: { type: "user_message", text: "u1" },
      },
      {
        seq: 13,
        timestamp: "2026-02-13T00:00:00.030Z",
        item: { type: "user_message", text: "u2" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "claude",
      direction: "after",
      limit: 2,
    });

    expect(selected.minSeq).toBe(10);
    expect(selected.maxSeq).toBe(12);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([10, 11, 12]);
    expect(selected.projectedEntries).toHaveLength(2);
  });

  test("uses max seqEnd across selected projected entries when tool lifecycle seqEnd is non-monotonic", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "working" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "codex",
      direction: "tail",
      limit: 2,
    });

    expect(selected.projectedEntries).toHaveLength(2);
    expect(selected.minSeq).toBe(1);
    expect(selected.maxSeq).toBe(3);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  test("expands projected entries for overlapping seq ranges", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "work" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "assistant_message", text: "ing" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.300Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "codex",
      direction: "after",
      limit: 1,
    });

    expect(selected.minSeq).toBe(1);
    expect(selected.maxSeq).toBe(4);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(selected.projectedEntries).toHaveLength(2);
    expect(selected.projectedEntries.map((entry) => entry.item.type)).toEqual([
      "tool_call",
      "assistant_message",
    ]);
  });

  test("before direction selects the latest projected entries from the earlier window", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "a" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "b" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "user_message", text: "u1" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.300Z",
        item: { type: "user_message", text: "u2" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "claude",
      direction: "before",
      limit: 1,
    });

    expect(selected.minSeq).toBe(4);
    expect(selected.maxSeq).toBe(4);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([4]);
    expect(selected.projectedEntries).toHaveLength(1);
    expect(selected.projectedEntries[0]?.item).toEqual({
      type: "user_message",
      text: "u2",
    });
  });

  test("can enforce a hard projected limit when tool lifecycle collapsing is disabled", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "work" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      provider: "codex",
      direction: "tail",
      limit: 1,
      collapseToolLifecycle: false,
    });

    expect(selected.minSeq).toBe(3);
    expect(selected.maxSeq).toBe(3);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([3]);
    expect(selected.projectedEntries).toHaveLength(1);
    expect(selected.projectedEntries[0]?.item.type).toBe("tool_call");
  });
});
