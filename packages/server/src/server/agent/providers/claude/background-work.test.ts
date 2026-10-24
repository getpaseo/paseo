import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";

import { ClaudeBackgroundWorkTracker } from "./background-work.js";

function system(fields: Record<string, unknown>): SDKMessage {
  return { type: "system", uuid: "u", session_id: "s", ...fields } as unknown as SDKMessage;
}

describe("ClaudeBackgroundWorkTracker", () => {
  test("reports no work before any turn ran on the process", () => {
    expect(new ClaudeBackgroundWorkTracker().state()).toEqual({ kind: "none" });
  });

  test("keeps a background shell live until its notification settles it", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.noteTurnStarted();
    tracker.observe(
      system({
        subtype: "task_started",
        task_id: "bash-1",
        task_type: "local_bash",
        is_backgrounded: true,
      }),
    );
    tracker.observe(system({ subtype: "session_state_changed", state: "idle" }));
    expect(tracker.state()).toMatchObject({ kind: "active", liveTaskIds: ["bash-1"] });

    tracker.observe(
      system({ subtype: "task_notification", task_id: "bash-1", status: "completed" }),
    );
    expect(tracker.state()).toEqual({ kind: "none" });
  });

  test("treats terminal task_updated statuses as settled and paused tasks as live", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.noteTurnStarted();
    tracker.observe(system({ subtype: "session_state_changed", state: "idle" }));
    tracker.observe(system({ subtype: "task_started", task_id: "monitor-1" }));
    tracker.observe(
      system({ subtype: "task_updated", task_id: "monitor-1", patch: { status: "paused" } }),
    );
    expect(tracker.state().kind).toBe("active");

    tracker.observe(
      system({ subtype: "task_updated", task_id: "monitor-1", patch: { status: "killed" } }),
    );
    expect(tracker.state()).toEqual({ kind: "none" });
  });

  test("a running session state is live work even without a declared task", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.noteTurnStarted();
    tracker.observe(system({ subtype: "session_state_changed", state: "running" }));
    expect(tracker.state()).toMatchObject({ kind: "active", sessionState: "running" });

    tracker.observe(system({ subtype: "session_state_changed", state: "requires_action" }));
    expect(tracker.state().kind).toBe("active");

    tracker.observe(system({ subtype: "session_state_changed", state: "idle" }));
    expect(tracker.state()).toEqual({ kind: "none" });
  });

  test("cannot prove idleness when a turn ran but no session state arrived", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.noteTurnStarted();
    expect(tracker.state().kind).toBe("unknown");
  });

  test("reset forgets work owned by an earlier process", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.noteTurnStarted();
    tracker.observe(system({ subtype: "task_started", task_id: "bash-1" }));
    tracker.reset();
    expect(tracker.state()).toEqual({ kind: "none" });
  });

  test("ignores non-system frames", () => {
    const tracker = new ClaudeBackgroundWorkTracker();
    tracker.observe({ type: "assistant" } as unknown as SDKMessage);
    expect(tracker.state()).toEqual({ kind: "none" });
  });
});
