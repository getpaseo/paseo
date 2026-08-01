import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { TimelineProjectionEntry } from "./timeline-projection.js";
import { analyzeMaterialProgress } from "./material-progress.js";

function entry(seq: number, item: AgentTimelineItem): TimelineProjectionEntry {
  return {
    item,
    timestamp: `2026-07-31T00:00:0${seq}.000Z`,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  };
}

describe("analyzeMaterialProgress", () => {
  it("reports none when history or a current continuation is unavailable", () => {
    expect(analyzeMaterialProgress({ entries: null, turnOutcome: null })).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Timeline history is unavailable.",
    });

    expect(analyzeMaterialProgress({ entries: [], turnOutcome: null }).state).toBe("none");
  });

  it("treats completed edits and writes as material progress", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "implement" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, {
          type: "tool_call",
          callId: "edit-1",
          name: "edit",
          status: "completed",
          error: null,
          detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "+change" },
        }),
        entry(4, { type: "compaction", status: "completed" }),
        entry(5, {
          type: "tool_call",
          callId: "write-1",
          name: "write",
          status: "completed",
          error: null,
          detail: { type: "write", filePath: "src/b.ts", content: "content" },
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toEqual({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: "2026-07-31T00:00:05.000Z",
      lastMaterialProgressKind: "write",
      reason: "Material progress followed the latest user message.",
    });
  });

  it("warns after one compaction and stalls after two", () => {
    expect(
      analyzeMaterialProgress({
        entries: [
          entry(1, { type: "user_message", text: "continue" }),
          entry(2, { type: "compaction", status: "completed" }),
        ],
        turnOutcome: null,
      }),
    ).toMatchObject({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
    });

    expect(
      analyzeMaterialProgress({
        entries: [
          entry(1, { type: "user_message", text: "continue" }),
          entry(2, { type: "compaction", status: "completed" }),
          entry(3, { type: "reasoning", text: "still working" }),
          entry(4, { type: "compaction", status: "completed" }),
        ],
        turnOutcome: null,
      }),
    ).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
    });
  });

  it("does not inherit a previous continuation's compactions after a new turn is accepted", () => {
    const previousContinuation = [
      entry(1, { type: "user_message", text: "old continuation" }),
      entry(2, { type: "compaction", status: "completed" }),
      entry(3, { type: "compaction", status: "completed" }),
    ];

    expect(
      analyzeMaterialProgress({ entries: previousContinuation, turnOutcome: null }),
    ).toMatchObject({ state: "stalled" });

    expect(
      analyzeMaterialProgress({
        entries: previousContinuation,
        turnOutcome: null,
        continuationBoundarySeq: 4,
      }),
    ).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "No material progress has been recorded for the current continuation.",
    });
  });

  it("uses only the latest user continuation and completion sequence", () => {
    const completedWrite = entry(2, {
      type: "tool_call",
      callId: "write-1",
      name: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "proof.txt", content: "passed" },
    });
    completedWrite.seqEnd = 5;

    expect(
      analyzeMaterialProgress({
        entries: [
          entry(1, { type: "user_message", text: "old work" }),
          entry(2, { type: "compaction", status: "completed" }),
          entry(3, { type: "user_message", text: "current work" }),
          completedWrite,
          entry(4, { type: "compaction", status: "completed" }),
        ],
        turnOutcome: null,
      }),
    ).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "write",
    });
  });

  it("keeps a read-only audit progressing across two compactions", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "audit the authentication flow" }),
        entry(2, {
          type: "tool_call",
          callId: "read-1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "src/auth.ts", content: "export function login() {}" },
        }),
        entry(3, { type: "compaction", status: "completed" }),
        entry(4, {
          type: "tool_call",
          callId: "search-1",
          name: "grep",
          status: "completed",
          error: null,
          detail: { type: "search", query: "login(", numFiles: 2, numMatches: 3 },
        }),
        entry(5, { type: "compaction", status: "completed" }),
        entry(6, {
          type: "tool_call",
          callId: "fetch-1",
          name: "fetch",
          status: "completed",
          error: null,
          detail: {
            type: "fetch",
            url: "https://example.com/auth-spec",
            result: "Tokens expire after one hour.",
            code: 200,
          },
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "evidence",
    });
  });

  it("keeps test-only verification progressing across two compactions", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "verify the change" }),
        entry(2, {
          type: "tool_call",
          callId: "test-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "npm test", output: "12 tests passed", exitCode: 0 },
        }),
        entry(3, { type: "compaction", status: "completed" }),
        entry(4, {
          type: "tool_call",
          callId: "build-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: "npm run build",
            output: "build complete",
            exitCode: 0,
          },
        }),
        entry(5, { type: "compaction", status: "completed" }),
        entry(6, {
          type: "tool_call",
          callId: "typecheck-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: {
            type: "shell",
            command: "npm run typecheck",
            output: "typecheck passed",
            exitCode: 0,
          },
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "verification",
    });
  });

  it("treats a non-empty explicit plan as a decision", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "decide how to proceed" }),
        entry(2, { type: "compaction", status: "completed" }),
        entry(3, {
          type: "tool_call",
          callId: "plan-1",
          name: "plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text: "Use the persisted boundary as the source of truth." },
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "decision",
    });
  });

  it("stalls on repeated irrelevant reads across two compactions", () => {
    const repeatedRead = {
      type: "read" as const,
      filePath: "notes/unrelated.txt",
      content: "unchanged unrelated notes",
    };
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "audit the authentication flow" }),
        entry(2, {
          type: "tool_call",
          callId: "read-1",
          name: "read",
          status: "completed",
          error: null,
          detail: repeatedRead,
        }),
        entry(3, { type: "compaction", status: "completed" }),
        entry(4, {
          type: "tool_call",
          callId: "read-2",
          name: "read",
          status: "completed",
          error: null,
          detail: repeatedRead,
        }),
        entry(5, { type: "compaction", status: "completed" }),
        entry(6, {
          type: "tool_call",
          callId: "read-3",
          name: "read",
          status: "completed",
          error: null,
          detail: repeatedRead,
        }),
      ],
      turnOutcome: null,
    });

    expect(result).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressAt: "2026-07-31T00:00:02.000Z",
      lastMaterialProgressKind: "evidence",
    });
  });

  it("does not count empty, failed, or no-op tools and commentary as material progress", () => {
    const result = analyzeMaterialProgress({
      entries: [
        entry(1, { type: "user_message", text: "investigate" }),
        entry(2, {
          type: "tool_call",
          callId: "read-1",
          name: "read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "src/a.ts" },
        }),
        entry(3, {
          type: "tool_call",
          callId: "search-1",
          name: "grep",
          status: "completed",
          error: null,
          detail: { type: "search", query: "TODO" },
        }),
        entry(4, {
          type: "tool_call",
          callId: "fetch-1",
          name: "fetch",
          status: "completed",
          error: null,
          detail: { type: "fetch", url: "https://example.com" },
        }),
        entry(5, {
          type: "tool_call",
          callId: "shell-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "false", output: "failed", exitCode: 1 },
        }),
        entry(6, {
          type: "tool_call",
          callId: "plan-1",
          name: "plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text: "   " },
        }),
        entry(7, { type: "assistant_message", text: "Still investigating." }),
        entry(8, {
          type: "tool_call",
          callId: "edit-1",
          name: "edit",
          status: "failed",
          error: "permission denied",
          detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "+change" },
        }),
        entry(9, { type: "compaction", status: "completed" }),
      ],
      turnOutcome: null,
    });

    expect(result).toMatchObject({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
      lastMaterialProgressKind: null,
    });
  });

  it("counts a completed turn's final message as a deliverable, not semantic success", () => {
    const entries = [
      entry(1, { type: "user_message", text: "answer" }),
      entry(2, { type: "assistant_message", text: "I am checking." }),
      entry(3, { type: "compaction", status: "completed" }),
      entry(4, { type: "assistant_message", text: "Delivered result." }),
    ];

    expect(analyzeMaterialProgress({ entries, turnOutcome: null }).state).toBe("warning");
    expect(analyzeMaterialProgress({ entries, turnOutcome: "failed" }).state).toBe("warning");
    expect(analyzeMaterialProgress({ entries, turnOutcome: "canceled" }).state).toBe("warning");
    expect(analyzeMaterialProgress({ entries, turnOutcome: "completed" })).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "assistant_result",
    });

    const emptyFinalMessage = [...entries, entry(5, { type: "assistant_message", text: "   " })];
    expect(
      analyzeMaterialProgress({ entries: emptyFinalMessage, turnOutcome: "completed" }),
    ).toMatchObject({
      state: "warning",
      lastMaterialProgressKind: null,
    });
  });
});
