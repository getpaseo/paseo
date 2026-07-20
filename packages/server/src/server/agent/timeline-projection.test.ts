import { describe, expect, test } from "vitest";

import type { AgentTimelineRow } from "./agent-manager.js";
import {
  projectTimelineRows,
  selectProjectedTimelinePage,
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

    const projected = projectTimelineRows({ rows, mode: "projected" });

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

  test("merges adjacent assistant chunks with the same message id in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel", messageId: "msg-1" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "lo", messageId: "msg-1" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "Hello",
      messageId: "msg-1",
    });
  });

  test("keeps adjacent assistant chunks with different message ids separate in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "First answer.", messageId: "msg-1" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "Second answer.", messageId: "msg-2" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "First answer.",
      messageId: "msg-1",
    });
    expect(projected[1]?.item).toEqual({
      type: "assistant_message",
      text: "Second answer.",
      messageId: "msg-2",
    });
  });

  test("merges adjacent reasoning chunks in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "reasoning", text: "Step " },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "reasoning", text: "by step" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "assistant_message", text: "done" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({ type: "reasoning", text: "Step by step" });
    expect(projected[0]?.collapsed).toContain("reasoning_merge");
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

    const projected = projectTimelineRows({ rows, mode: "projected" });

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

    const projected = projectTimelineRows({ rows, mode: "canonical" });

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

  test("tail limit treats a repeated running tool call as one projected item", () => {
    const rows: AgentTimelineRow[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        seq: index + 1,
        timestamp: `2026-02-13T00:00:00.00${index}Z`,
        item: { type: "assistant_message" as const, text: `old ${index}` },
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        seq: index + 7,
        timestamp: `2026-02-13T00:00:01.0${index}Z`,
        item: {
          type: "tool_call" as const,
          callId: "call_1",
          name: "shell",
          status: "running" as const,
          error: null,
          detail: {
            type: "unknown" as const,
            input: { cmd: "sleep 10" },
            output: { progress: index },
          },
        },
      })),
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "tail",
      limit: 100,
    });

    const tools = selected.projectedEntries.filter((entry) => entry.item.type === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.collapsed).toContain("tool_lifecycle");
    expect(selected.projectedEntries).toHaveLength(2);
  });
});

describe("selectProjectedTimelinePage", () => {
  function toolRow(seq: number, status: "running" | "completed"): AgentTimelineRow {
    return {
      seq,
      timestamp: new Date(1000 + seq).toISOString(),
      item: {
        type: "tool_call",
        callId: "call_1",
        name: "shell",
        status,
        error: null,
        detail: {
          type: "unknown",
          input: { cmd: "sleep 10" },
          output: status === "completed" ? { stdout: "done" } : null,
        },
      },
    };
  }

  test("tail page returns full projected items instead of tool lifecycle deltas", () => {
    const rows: AgentTimelineRow[] = [
      { seq: 1, timestamp: "2026-02-13T00:00:00.000Z", item: { type: "user_message", text: "go" } },
      ...Array.from({ length: 120 }, (_, index) => toolRow(index + 2, "running")),
    ];

    const page = selectProjectedTimelinePage({ rows, direction: "tail", limit: 100 });

    expect(page.entries.map((entry) => entry.item.type)).toEqual(["user_message", "tool_call"]);
    expect(page.entries[1]?.collapsed).toContain("tool_lifecycle");
    expect(page.entries[1]?.sourceSeqRanges).toEqual([{ startSeq: 2, endSeq: 121 }]);
    expect(page.startSeq).toBe(1);
    expect(page.endSeq).toBe(121);
    expect(page.hasNewer).toBe(false);
  });

  test("after page includes a full projected tool item when only its update is new", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(10, "running"),
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.011Z",
        item: { type: "assistant_message", text: "working" },
      },
      toolRow(250, "completed"),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 249,
      limit: 100,
    });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.item.type).toBe("tool_call");
    expect(page.entries[0]?.seqStart).toBe(10);
    expect(page.entries[0]?.seqEnd).toBe(250);
    expect(page.entries[0]?.sourceSeqRanges).toEqual([
      { startSeq: 10, endSeq: 10 },
      { startSeq: 250, endSeq: 250 },
    ]);
    expect(page.startSeq).toBe(250);
    expect(page.endSeq).toBe(250);
  });

  test("after page cursor advances only through contiguously covered seqs", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 498 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(500, "completed"),
      ...Array.from({ length: 101 }, (_, index) => ({
        seq: index + 501,
        timestamp: new Date(3000 + index).toISOString(),
        item: { type: "user_message" as const, text: `later ${index + 501}` },
      })),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 0,
      limit: 100,
    });

    expect(page.entries[0]?.item.type).toBe("tool_call");
    expect(
      page.entries.some((entry) => entry.item.type === "user_message" && entry.seqStart === 101),
    ).toBe(false);
    expect(page.endSeq).toBe(100);
    expect(page.hasNewer).toBe(true);
  });

  test("after limit counts projected entries while preserving their canonical sequence coverage", () => {
    const rows: AgentTimelineRow[] = [
      ...Array.from({ length: 200 }, (_, index) => ({
        seq: index + 1,
        timestamp: new Date(1000 + index).toISOString(),
        item: { type: "assistant_message" as const, text: "x" },
      })),
      ...Array.from({ length: 150 }, (_, index) => ({
        seq: index + 201,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `message ${index + 1}` },
      })),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 0,
      limit: 100,
    });

    expect({
      entryCount: page.entries.length,
      firstEntry: page.entries[0],
      lastEntry: page.entries.at(-1),
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      hasNewer: page.hasNewer,
    }).toEqual({
      entryCount: 100,
      firstEntry: {
        item: {
          type: "assistant_message",
          text: "x".repeat(200),
        },
        timestamp: new Date(1199).toISOString(),
        seqStart: 1,
        seqEnd: 200,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 200 }],
        collapsed: ["assistant_merge"],
      },
      lastEntry: {
        item: { type: "user_message", text: "message 99" },
        timestamp: new Date(2098).toISOString(),
        seqStart: 299,
        seqEnd: 299,
        sourceSeqRanges: [{ startSeq: 299, endSeq: 299 }],
        collapsed: [],
      },
      startSeq: 1,
      endSeq: 299,
      hasNewer: true,
    });
  });

  test("before page includes a wide tool whose earlier source range is before the cursor", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 498 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(500, "completed"),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: 500,
      limit: 100,
    });

    expect(page.entries.some((entry) => entry.item.type === "tool_call")).toBe(true);
    expect(page.endSeq).toBeLessThan(500);
    expect(page.hasOlder).toBe(true);
  });

  test("tail page includes a wide tool when its completion is the newest seq", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 499 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(501, "completed"),
    ];

    const page = selectProjectedTimelinePage({ rows, direction: "tail", limit: 100 });

    expect(page.entries.some((entry) => entry.item.type === "tool_call")).toBe(true);
    expect(page.endSeq).toBe(501);
  });
});
