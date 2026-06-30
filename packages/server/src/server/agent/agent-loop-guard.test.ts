import { beforeEach, describe, expect, it } from "vitest";
import {
  createLoopGuardState,
  DEFAULT_LOOP_GUARD_THRESHOLD,
  observeToolCall,
  toolCallSignature,
} from "./agent-loop-guard.js";
import type { ToolCallTimelineItem } from "./agent-sdk-types.js";

let callSeq = 0;

function shellCall(
  command: string,
  opts: {
    status?: "running" | "completed" | "failed";
    exitCode?: number | null;
    callId?: string;
  } = {},
): ToolCallTimelineItem {
  const status = opts.status ?? "completed";
  const base = {
    type: "tool_call" as const,
    callId: opts.callId ?? `call-${++callSeq}`,
    name: "shell",
    detail: { type: "shell" as const, command, exitCode: opts.exitCode ?? 0 },
  };
  if (status === "failed") {
    return { ...base, status, error: new Error("boom") };
  }
  return { ...base, status, error: null };
}

describe("agent-loop-guard", () => {
  // Reset per test so generated callId uniqueness never depends on execution order.
  beforeEach(() => {
    callSeq = 0;
  });

  it("does not trip on productive (exit 0) repeated commands", () => {
    const state = createLoopGuardState();
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD * 2; i++) {
      const outcome = observeToolCall(state, shellCall("npm test", { exitCode: 0 }), "turn-1");
      expect(outcome.tripped).toBe(false);
    }
  });

  it("trips on a shell command that completes with a non-zero exit code repeatedly", () => {
    // The rtk-lint case: tool 'completes' but the command itself fails (exit != 0).
    const state = createLoopGuardState();
    let tripped: { tripped: true; signature: string; count: number } | null = null;
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD; i++) {
      const outcome = observeToolCall(state, shellCall("rtk lint", { exitCode: 127 }), "turn-1");
      if (outcome.tripped) {
        tripped = outcome;
      }
    }
    expect(tripped).not.toBeNull();
    expect(tripped?.signature).toBe("shell:rtk lint");
    expect(tripped?.count).toBe(DEFAULT_LOOP_GUARD_THRESHOLD);
  });

  it("trips on repeated status:failed tool calls", () => {
    const state = createLoopGuardState();
    const outcomes = Array.from({ length: DEFAULT_LOOP_GUARD_THRESHOLD }, () =>
      observeToolCall(state, shellCall("flaky", { status: "failed" }), "turn-1"),
    );
    expect(outcomes.filter((o) => o.tripped)).toHaveLength(1);
  });

  it("fires the trip exactly once per stuck streak", () => {
    const state = createLoopGuardState();
    let trips = 0;
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD + 10; i++) {
      if (observeToolCall(state, shellCall("rtk lint", { exitCode: 1 }), "turn-1").tripped) {
        trips++;
      }
    }
    expect(trips).toBe(1);
  });

  it("resets the streak when a different action runs in between", () => {
    const state = createLoopGuardState();
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD - 1; i++) {
      expect(observeToolCall(state, shellCall("rtk lint", { exitCode: 1 }), "turn-1").tripped).toBe(
        false,
      );
    }
    // A different (productive) action breaks the streak.
    observeToolCall(state, shellCall("npm run build", { exitCode: 0 }), "turn-1");
    // Back to the bad command — counter restarted, so one more does not trip.
    expect(observeToolCall(state, shellCall("rtk lint", { exitCode: 1 }), "turn-1").tripped).toBe(
      false,
    );
  });

  it("resets the streak on a new turn", () => {
    const state = createLoopGuardState();
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD - 1; i++) {
      observeToolCall(state, shellCall("rtk lint", { exitCode: 1 }), "turn-1");
    }
    // New turn id resets everything.
    expect(observeToolCall(state, shellCall("rtk lint", { exitCode: 1 }), "turn-2").tripped).toBe(
      false,
    );
  });

  it("does not double-count status transitions of the same call id", () => {
    const state = createLoopGuardState();
    // The same callId emitting a terminal event twice must count once.
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD * 2; i++) {
      const outcome = observeToolCall(
        state,
        shellCall("rtk lint", { exitCode: 1, callId: "same-call" }),
        "turn-1",
      );
      expect(outcome.tripped).toBe(false);
    }
  });

  it("ignores running tool calls", () => {
    const state = createLoopGuardState();
    for (let i = 0; i < DEFAULT_LOOP_GUARD_THRESHOLD * 2; i++) {
      expect(
        observeToolCall(state, shellCall("rtk lint", { status: "running" }), "turn-1").tripped,
      ).toBe(false);
    }
  });

  it("builds stable signatures per detail type", () => {
    expect(toolCallSignature(shellCall("ls -la"))).toBe("shell:ls -la");
  });
});
