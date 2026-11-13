import { describe, expect, test } from "vitest";
import { ClaudeScheduledWakeups } from "./scheduled-wakeups.js";

// Frames captured from claude 2.1.323 (stream-json, SDK entrypoint) in Asia/Bangkok (UTC+7).
const TIME_ZONE = "Asia/Bangkok";

function toolUse(id: string, name: string, input: unknown, parent: string | null = null) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
    parent_tool_use_id: parent,
  };
}

function toolResult(id: string, content: unknown, isError = false) {
  const error = isError ? { is_error: true } : {};
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: id, type: "tool_result", content, ...error }],
    },
    parent_tool_use_id: null,
  };
}

function fire(wakeupSource: string | null) {
  return {
    type: "command_lifecycle",
    command_uuid: "0bf4465e-22d2-4213-a3cc-ae5bc18a2d15",
    state: "started",
    wakeup_source: wakeupSource,
  };
}

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

    // The cron fires first, 62 s after its 01:56 slot; the next run keeps that jitter
    // (02:00 nominal, 02:01 observed).
    clock.set("2026-11-13T18:57:02.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-13T18:58:00.073Z");

    clock.set("2026-11-13T18:58:01.000Z");
    expect(wakeups.observe(fire("loop_wakeup"))).toBe("2026-11-13T19:01:02.000Z");

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

  test("follows a job that runs ahead of its slots, even when Claude skips the first one", () => {
    // Captured on a dev daemon: created at 02:29:48 local, Claude skipped the 02:30 slot and the
    // first run came at 02:34:34, 26 s before 02:35.
    const clock = createClock("2026-11-13T19:29:48.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(
      toolUse("toolu_cron", "CronCreate", { cron: "*/5 * * * *", recurring: true, durable: false }),
    );
    expect(
      wakeups.observe(
        toolResult(
          "toolu_cron",
          "Scheduled recurring job d17dc700 (Every 5 minutes). Next run: Nov 14 2:35am. Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.",
        ),
      ),
    ).toBe("2026-11-13T19:35:00.000Z");

    clock.set("2026-11-13T19:34:34.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-13T19:39:34.000Z");
    clock.set("2026-11-13T19:39:34.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-13T19:44:34.000Z");
  });

  test("does not count an early run's own slot as the next one", () => {
    const clock = createClock("2026-11-13T19:27:00.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_cron", "CronCreate", { cron: "*/5 * * * *" }));
    expect(
      wakeups.observe(
        toolResult("toolu_cron", "Scheduled recurring job e5f6. Next run: Nov 14 2:30am."),
      ),
    ).toBe("2026-11-13T19:30:00.000Z");

    // 02:30 runs at 02:29:34: the next wake is 02:34:34, not the 02:30 slot that just ran.
    clock.set("2026-11-13T19:29:34.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-13T19:34:34.000Z");
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

  test("keeps a recurring cron through its final run, seven days after creation", () => {
    const clock = createClock("2026-11-13T19:27:00.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_cron", "CronCreate", { cron: "0 3 * * *" }));
    expect(
      wakeups.observe(
        toolResult(
          "toolu_cron",
          "Scheduled recurring job 9c8d (Every day). Next run: Nov 14 3:00am.",
        ),
      ),
    ).toBe("2026-11-13T20:00:00.000Z");
    for (const day of [13, 14, 15, 16, 17, 18, 19]) {
      clock.set(`2026-11-${day}T20:00:00.000Z`);
      expect(wakeups.observe(fire("schedule_wakeup"))).toBe(`2026-11-${day + 1}T20:00:00.000Z`);
    }
    // The Nov 20 run is the first one seven days after creation: Claude makes it, then deletes the job.
    clock.set("2026-11-20T20:00:00.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBeNull();
  });

  test("does not measure a jitter from fires it cannot tell apart", () => {
    // Both jobs are reported for noon; the 5-minute one runs 26 s early, the hourly one 56 s late.
    const clock = createClock("2026-11-14T04:57:00.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_hourly", "CronCreate", { cron: "0 * * * *" }));
    expect(
      wakeups.observe(
        toolResult(
          "toolu_hourly",
          "Scheduled recurring job aaaa1111 (Every hour). Next run: Nov 14 12:00pm.",
        ),
      ),
    ).toBe("2026-11-14T05:00:00.000Z");
    wakeups.observe(toolUse("toolu_five", "CronCreate", { cron: "*/5 * * * *" }));
    expect(
      wakeups.observe(
        toolResult(
          "toolu_five",
          "Scheduled recurring job bbbb2222 (Every 5 minutes). Next run: Nov 14 12:00pm.",
        ),
      ),
    ).toBeUndefined();

    clock.set("2026-11-14T04:59:34.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBeUndefined();
    clock.set("2026-11-14T05:00:56.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-14T05:05:00.000Z");
    // Alone in its minute, the 5-minute job's next fire is its own and shows its jitter.
    clock.set("2026-11-14T05:04:34.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-14T05:09:34.000Z");

    wakeups.observe(toolUse("toolu_delete", "CronDelete", { id: "bbbb2222" }));
    expect(wakeups.observe(toolResult("toolu_delete", "Cancelled job bbbb2222."))).toBe(
      "2026-11-14T06:00:00.000Z",
    );
  });

  test("keeps a job's jitter when its run waited for a busy turn", () => {
    const clock = createClock("2026-11-14T04:57:00.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    wakeups.observe(toolUse("toolu_cron", "CronCreate", { cron: "0 * * * *" }));
    expect(
      wakeups.observe(
        toolResult(
          "toolu_cron",
          "Scheduled recurring job c3d4 (Every hour). Next run: Nov 14 12:01pm.",
        ),
      ),
    ).toBe("2026-11-14T05:01:00.000Z");
    clock.set("2026-11-14T05:00:56.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-14T06:00:56.000Z");
    // The 13:00 run came 39 minutes late, after a long turn: it says nothing about the jitter.
    clock.set("2026-11-14T06:40:00.000Z");
    expect(wakeups.observe(fire("schedule_wakeup"))).toBe("2026-11-14T07:00:56.000Z");
  });

  test("reads a reported time across a daylight-saving change", () => {
    // New York moves its clocks from 2:00 to 3:00 on 2027-03-14.
    const clock = createClock("2027-03-14T06:00:00.000Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, "America/New_York");
    wakeups.observe(toolUse("toolu_cron", "CronCreate", { cron: "30 3 * * *" }));
    expect(
      wakeups.observe(
        toolResult("toolu_cron", "Scheduled recurring job 0a1b. Next run: Mar 14 3:30am."),
      ),
    ).toBe("2027-03-14T07:30:00.000Z");
  });

  test("stops counting a wake that never fires", () => {
    const clock = createClock("2026-11-13T18:54:35.073Z");
    const wakeups = new ClaudeScheduledWakeups(clock.now, TIME_ZONE);
    scheduleBoth(clock, wakeups);
    // Claude runs a due wake as soon as it is idle, so these ones are gone half an hour later.
    clock.set("2026-11-13T19:28:00.073Z");
    expect(wakeups.hasPending()).toBe(true);
    clock.set("2026-11-13T19:28:00.074Z");
    expect(wakeups.hasPending()).toBe(false);
    expect(wakeups.observe(fire(null))).toBeNull();
  });
});
