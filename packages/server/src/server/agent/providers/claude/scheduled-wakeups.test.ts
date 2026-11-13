import { describe, expect, test } from "vitest";
import { ClaudeScheduledWakeups } from "./scheduled-wakeups.js";

// Frames captured from claude 2.1.323 (stream-json, SDK entrypoint) in Asia/Bangkok (UTC+7).
const TIME_ZONE = "Asia/Bangkok";

const toolUse = (id: string, name: string, input: unknown, parent: string | null = null) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
  parent_tool_use_id: parent,
});

const toolResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { tool_use_id: id, type: "tool_result", content, ...(isError ? { is_error: true } : {}) },
    ],
  },
  parent_tool_use_id: null,
});

const fire = (wakeupSource: string | null) => ({
  type: "command_lifecycle",
  command_uuid: "0bf4465e-22d2-4213-a3cc-ae5bc18a2d15",
  state: "started",
  wakeup_source: wakeupSource,
});

const WAKEUP_RESULT =
  "Next wakeup scheduled for 01:58:00 (in 205s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.";
const CRON_RESULT =
  "Scheduled recurring job 878c515b (Every 4 minutes). Next run: Nov 14 1:57am. Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.";

function createClock(iso: string) {
  let now = Date.parse(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = Date.parse(next);
    },
  };
}

function scheduleBoth(clock: ReturnType<typeof createClock>, wakeups: ClaudeScheduledWakeups) {
  wakeups.observe(
    toolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 180, prompt: "Reply only OK." }),
  );
  expect(wakeups.observe(toolResult("toolu_wake", WAKEUP_RESULT))).toBe("2026-11-13T18:58:00.073Z");
  clock.set("2026-11-13T18:54:35.384Z");
  wakeups.observe(
    toolUse("toolu_cron", "CronCreate", {
      cron: "*/4 * * * *",
      prompt: "Reply only OK.",
      recurring: true,
      durable: false,
    }),
  );
  // Claude jitters the */4 job one minute late: 01:57 local, before the 01:58 wakeup.
  expect(wakeups.observe(toolResult("toolu_cron", CRON_RESULT))).toBe("2026-11-13T18:57:00.000Z");
}

describe("ClaudeScheduledWakeups", () => {
  test("follows a wakeup and a recurring cron through the fires Claude reports", () => {
    const clock = createClock("2026-11-13T18:54:35.073Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    scheduleBoth(clock, wakeups);
    expect(wakeups.hasPending()).toBe(true);

    // The cron fires first; its next run keeps the jitter (02:00 nominal, 02:01 observed).
    clock.set("2026-11-13T18:57:02.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-13T18:58:00.073Z");

    clock.set("2026-11-13T18:58:01.000Z");
    expect(wakeups.observe(fire("loop_wakeup"))).toBe("2026-11-13T19:01:00.000Z");

    wakeups.observe(toolUse("toolu_delete", "CronDelete", { id: "878c515b" }));
    expect(wakeups.observe(toolResult("toolu_delete", "Cancelled job 878c515b."))).toBeNull();
    expect(wakeups.hasPending()).toBe(false);
  });

  test("reports only changes", () => {
    const clock = createClock("2026-11-13T18:54:35.073Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    scheduleBoth(clock, wakeups);
    expect(wakeups.observe(fire("loop_wakeup"))).toBeUndefined();
    expect(wakeups.observe(fire(null))).toBeUndefined();
    expect(wakeups.observe({ type: "command_lifecycle", state: "completed" })).toBeUndefined();
  });

  test("drops a one-shot cron once it fires", () => {
    const clock = createClock("2026-11-13T18:54:35.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(
      toolUse("toolu_once", "CronCreate", { cron: "30 2 14 11 *", recurring: false }),
    );
    expect(
      wakeups.observe(
        toolResult("toolu_once", "Scheduled one-shot job a1b2c3d4. Next run: Nov 14 2:30am."),
      ),
    ).toBe("2026-11-13T19:30:00.000Z");
    clock.set("2026-11-13T19:30:00.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBeNull();
  });

  test("falls back to the requested delay and the cron expression", () => {
    const clock = createClock("2026-11-13T18:54:30.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_wake", "ScheduleWakeup", { delaySeconds: 20 }));
    // Claude clamps delays to at least a minute.
    expect(wakeups.observe(toolResult("toolu_wake", "Scheduled."))).toBe(
      "2026-11-13T18:55:30.000Z",
    );
    wakeups.observe(toolUse("toolu_cron", "CronCreate", { cron: "*/4 * * * *" }));
    // The wakeup is still the earliest, so nothing changes yet.
    expect(
      wakeups.observe(toolResult("toolu_cron", [{ type: "text", text: "job x1" }])),
    ).toBeUndefined();
    wakeups.observe(toolUse("toolu_stop", "ScheduleWakeup", { stop: true }));
    // Without a reported time, the cron's next nominal run is used.
    expect(wakeups.observe(toolResult("toolu_stop", "Loop stopped."))).toBe(
      "2026-11-13T18:56:00.000Z",
    );
  });

  test("ignores failed calls and subagent calls", () => {
    const clock = createClock("2026-11-13T18:54:35.073Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_fail", "ScheduleWakeup", { delaySeconds: 180 }));
    expect(wakeups.observe(toolResult("toolu_fail", WAKEUP_RESULT, true))).toBeUndefined();
    wakeups.observe(toolUse("toolu_sub", "ScheduleWakeup", { delaySeconds: 180 }, "toolu_task"));
    expect(wakeups.observe(toolResult("toolu_sub", WAKEUP_RESULT))).toBeUndefined();
    expect(wakeups.hasPending()).toBe(false);
  });

  test("forgets everything on reset", () => {
    const clock = createClock("2026-11-13T18:54:35.073Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    scheduleBoth(clock, wakeups);
    wakeups.reset();
    expect(wakeups.hasPending()).toBe(false);
    wakeups.observe(toolUse("toolu_again", "ScheduleWakeup", { delaySeconds: 180 }));
    expect(wakeups.observe(toolResult("toolu_again", WAKEUP_RESULT))).toBe(
      "2026-11-13T18:58:00.384Z",
    );
  });
});
