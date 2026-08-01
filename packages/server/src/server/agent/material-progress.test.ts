import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  advanceMaterialProgressCheckpoint,
  materialProgressPayload,
  openMaterialProgressContinuation,
  rebindMaterialProgressCheckpoint,
  settleMaterialProgressContinuation,
} from "./material-progress.js";

function row(seq: number, item: AgentTimelineItem): AgentTimelineRow {
  return { seq, timestamp: `2026-08-01T00:00:${String(seq).padStart(2, "0")}.000Z`, item };
}

function acceptedCheckpoint() {
  return openMaterialProgressContinuation({
    timelineEpoch: "epoch-1",
    boundarySeq: 1,
    turnId: "turn-1",
  });
}

function applyRows(rows: AgentTimelineRow[]) {
  return rows.reduce(
    (checkpoint, current) => advanceMaterialProgressCheckpoint(checkpoint, current, "epoch-1"),
    acceptedCheckpoint(),
  );
}

describe("material progress checkpoint", () => {
  it("warns after one compaction and stalls after two", () => {
    const warning = applyRows([row(1, { type: "compaction", status: "completed" })]);
    expect(materialProgressPayload(warning)).toMatchObject({
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
    });

    const stalled = advanceMaterialProgressCheckpoint(
      warning,
      row(2, { type: "compaction", status: "completed" }),
      "epoch-1",
    );
    expect(materialProgressPayload(stalled)).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
    });
  });

  it("counts concrete read, verification, decision, edit, and write results", () => {
    const checkpoint = applyRows([
      row(1, {
        type: "tool_call",
        callId: "read-1",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "src/auth.ts", content: "export const auth = true;" },
      }),
      row(2, { type: "compaction", status: "completed" }),
      row(3, {
        type: "tool_call",
        callId: "test-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", output: "12 passed", exitCode: 0 },
      }),
      row(4, { type: "compaction", status: "completed" }),
      row(5, {
        type: "tool_call",
        callId: "plan-1",
        name: "plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: "Use the accepted boundary." },
      }),
      row(6, {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "+change" },
      }),
      row(7, {
        type: "tool_call",
        callId: "write-1",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "proof.txt", content: "done" },
      }),
    ]);

    expect(materialProgressPayload(checkpoint)).toMatchObject({
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressKind: "write",
    });
  });

  it("does not let repeated identical evidence reset compactions", () => {
    const read = row(1, {
      type: "tool_call",
      callId: "read-1",
      name: "read",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: "notes.txt", content: "unchanged" },
    });
    let checkpoint = applyRows([read, row(2, { type: "compaction", status: "completed" })]);
    checkpoint = advanceMaterialProgressCheckpoint(
      checkpoint,
      { ...read, seq: 3, timestamp: "2026-08-01T00:00:03.000Z" },
      "epoch-1",
    );
    checkpoint = advanceMaterialProgressCheckpoint(
      checkpoint,
      row(4, { type: "compaction", status: "completed" }),
      "epoch-1",
    );

    expect(materialProgressPayload(checkpoint)).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
      lastMaterialProgressKind: "evidence",
    });
  });

  it("counts only a successfully completed turn's trailing assistant result", () => {
    const withAssistant = applyRows([
      row(1, { type: "compaction", status: "completed" }),
      row(2, { type: "assistant_message", text: "Delivered " }),
      row(3, { type: "assistant_message", text: "result." }),
    ]);

    expect(
      materialProgressPayload(
        settleMaterialProgressContinuation(withAssistant, {
          turnId: "turn-1",
          outcome: "failed",
        }),
      ).state,
    ).toBe("warning");
    expect(
      materialProgressPayload(
        settleMaterialProgressContinuation(withAssistant, {
          turnId: "turn-1",
          outcome: "completed",
        }),
      ),
    ).toMatchObject({ state: "progressing", lastMaterialProgressKind: "assistant_result" });
  });

  it("binds restored state to the current epoch and rejects impossible cursors", () => {
    const checkpoint = applyRows([row(1, { type: "compaction", status: "completed" })]);
    const rebound = rebindMaterialProgressCheckpoint(checkpoint, {
      timelineEpoch: "epoch-2",
      nextSeq: 2,
    });
    expect(materialProgressPayload(rebound)).toMatchObject({
      state: "warning",
      timelineEpoch: "epoch-2",
      continuationBoundarySeq: 1,
    });

    const invalid = rebindMaterialProgressCheckpoint(checkpoint, {
      timelineEpoch: "epoch-reset",
      nextSeq: 1,
    });
    expect(materialProgressPayload(invalid)).toMatchObject({
      state: "none",
      timelineEpoch: "epoch-reset",
      continuationBoundarySeq: null,
    });
  });

  it("marks a sequence gap unavailable instead of reusing a stale signal", () => {
    const checkpoint = advanceMaterialProgressCheckpoint(
      acceptedCheckpoint(),
      row(10_001, {
        type: "tool_call",
        callId: "write-after-gap",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "proof.txt", content: "new" },
      }),
      "epoch-1",
    );

    expect(materialProgressPayload(checkpoint)).toMatchObject({
      state: "none",
      observedThroughSeq: 10_001,
      continuationBoundarySeq: null,
    });
  });

  it("clears a stale signal when a row belongs to a different timeline epoch", () => {
    const checkpoint = applyRows([
      row(1, {
        type: "tool_call",
        callId: "write-before-reset",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "proof.txt", content: "old" },
      }),
    ]);

    const reset = advanceMaterialProgressCheckpoint(
      checkpoint,
      row(1, { type: "reasoning", text: "replacement history" }),
      "epoch-reset",
    );
    expect(materialProgressPayload(reset)).toMatchObject({
      state: "none",
      timelineEpoch: "epoch-reset",
      continuationBoundarySeq: null,
      observedThroughSeq: 1,
      lastMaterialProgressKind: null,
    });
  });

  it("accumulates beyond ten thousand contiguous rows without a capped-history fallback", () => {
    let checkpoint = acceptedCheckpoint();
    for (let seq = 1; seq <= 10_000; seq += 1) {
      checkpoint = advanceMaterialProgressCheckpoint(
        checkpoint,
        row(seq, { type: "reasoning", text: `step ${seq}` }),
        "epoch-1",
      );
    }
    checkpoint = advanceMaterialProgressCheckpoint(
      checkpoint,
      row(10_001, {
        type: "tool_call",
        callId: "write-after-history",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "proof.txt", content: "new" },
      }),
      "epoch-1",
    );

    expect(materialProgressPayload(checkpoint)).toMatchObject({
      state: "progressing",
      observedThroughSeq: 10_001,
      continuationBoundarySeq: 1,
      lastMaterialProgressKind: "write",
    });
  });
});
