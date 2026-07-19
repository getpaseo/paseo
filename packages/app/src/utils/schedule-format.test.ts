import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCron,
  everyMsToParts,
  formatCadence,
  formatNextRun,
  isNewAgentSchedule,
  scheduleProductName,
  partsToEveryMs,
  resolveScheduleTitle,
  validateCron,
} from "./schedule-format";

function createSchedule(input: {
  name?: string | null;
  prompt?: string;
  title?: string | null;
  targetType?: "agent" | "new-agent";
}): ScheduleSummary {
  return {
    id: "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt ?? "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target:
      input.targetType === "agent"
        ? { type: "agent", agentId: "00000000-0000-4000-8000-000000000000" }
        : {
            type: "new-agent",
            config: {
              provider: "codex",
              cwd: "/tmp/project",
              title: input.title,
            },
          },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("schedule title helpers", () => {
  it("identifies new-agent schedules", () => {
    expect(isNewAgentSchedule(createSchedule({ targetType: "new-agent" }))).toBe(true);
    expect(isNewAgentSchedule(createSchedule({ targetType: "agent" }))).toBe(false);
  });

  it("labels engine records by product meaning", () => {
    expect(scheduleProductName(createSchedule({ targetType: "new-agent" }))).toBe("Schedule");
    expect(scheduleProductName(createSchedule({ targetType: "agent" }))).toBe("Heartbeat");
  });

  it("resolves display titles by name, config title, prompt, then fallback", () => {
    expect(
      resolveScheduleTitle(createSchedule({ name: "Morning run", title: "Config title" })),
    ).toBe("Morning run");
    expect(resolveScheduleTitle(createSchedule({ name: " ", title: "Config title" }))).toBe(
      "Config title",
    );
    expect(
      resolveScheduleTitle(createSchedule({ name: " ", title: " ", prompt: "\nPrompt line" })),
    ).toBe("Prompt line");
    expect(resolveScheduleTitle(createSchedule({ name: " ", title: " ", prompt: "\n  " }))).toBe(
      "Untitled schedule",
    );
  });
});

describe("interval formatting", () => {
  it("round-trips interval parts and formats cadence labels", () => {
    expect(everyMsToParts(2 * 24 * 60 * 60_000)).toEqual({ value: 2, unit: "days" });
    expect(everyMsToParts(3 * 60 * 60_000)).toEqual({ value: 3, unit: "hours" });
    expect(everyMsToParts(90_000)).toEqual({ value: 2, unit: "minutes" });
    expect(everyMsToParts(0)).toEqual({ value: 1, unit: "hours" });

    expect(partsToEveryMs(2, "hours")).toBe(2 * 60 * 60_000);
    expect(partsToEveryMs(0, "minutes")).toBe(60_000);
    expect(formatCadence({ type: "every", everyMs: 2 * 60 * 60_000 })).toBe("Every 2 hours");
  });
});

describe("describeCron", () => {
  it("humanizes common fixed-time cron shapes", () => {
    expect(describeCron({ type: "cron", expression: "* * * * *" })).toBe("Every minute");
    expect(describeCron({ type: "cron", expression: "0 * * * *" })).toBe("Every hour");
    expect(describeCron({ type: "cron", expression: "15 * * * *" })).toBe("Every hour at :15");
    expect(describeCron({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 1-5" })).toBe("Weekdays at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 0,6" })).toBe("Weekends at 09:00 UTC");
    expect(describeCron({ type: "cron", expression: "0 9 * * 1" })).toBe("Mondays at 09:00 UTC");
  });

  it("labels fixed-time cron cadences with their stored timezone", () => {
    expect(
      describeCron({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toBe("Daily at 09:00 America/New_York");
    expect(
      formatCadence({
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Madrid",
      }),
    ).toBe("Weekdays at 09:00 Europe/Madrid");
  });

  it("keeps timezone-less fixed-time cron cadences labeled as UTC", () => {
    expect(formatCadence({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
  });

  it("returns null for invalid or unrecognized valid cron expressions", () => {
    expect(describeCron({ type: "cron", expression: "not a cron" })).toBeNull();
    expect(describeCron({ type: "cron", expression: "*/5 * * * *" })).toBeNull();
    expect(formatCadence({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00 UTC");
  });
});

describe("validateCron", () => {
  it("accepts structurally valid cron expressions", () => {
    expect(validateCron("*/5 9-17 * 1,6 1-5")).toBeNull();
  });

  it("rejects step fields with extra slash tokens", () => {
    expect(validateCron("*/5/2 * * * *")).toBe("Invalid minute step");
  });

  it("rejects malformed fields with targeted messages", () => {
    expect(validateCron("")).toBe("Enter a cron expression");
    expect(validateCron("* * *")).toBe("Cron expressions must have 5 fields");
    expect(validateCron("60 * * * *")).toBe("Invalid minute value");
    expect(validateCron("* 24 * * *")).toBe("Invalid hour value");
    expect(validateCron("* * 31-1 * *")).toBe("Invalid day-of-month range");
    expect(validateCron("* * * */0 *")).toBe("Invalid month step");
    expect(validateCron("* * * * mon")).toBe("Invalid day-of-week value");
  });
});

describe("formatNextRun", () => {
  it("formats next-run distance from the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    expect(formatNextRun(null)).toBe("");
    expect(formatNextRun("not-a-date")).toBe("");
    expect(formatNextRun("2026-01-01T00:00:15.000Z")).toBe("soon");
    expect(formatNextRun("2026-01-01T00:30:00.000Z")).toBe("in 30m");
    expect(formatNextRun("2026-01-01T03:00:00.000Z")).toBe("in 3h");
    expect(formatNextRun("2026-01-03T00:00:00.000Z")).toBe("in 2d");
  });
});
