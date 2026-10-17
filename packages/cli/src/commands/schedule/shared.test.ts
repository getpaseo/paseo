import { describe, expect, test, vi } from "vitest";

import { selectDaemonTarget } from "../../utils/daemon-target.js";

import { createScheduleInspectRows, heartbeatSchema, scheduleSchema } from "./schema.js";
import {
  compileEveryPresetToCron,
  parseScheduleCreateInput,
  parseScheduleUpdateInput,
  requireScheduleWorkspaceSupport,
  toScheduleRow,
} from "./shared.js";
import type { ScheduleDaemonClient, ScheduleRecord } from "./types.js";

const baseOptions = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  every: "5m",
  provider: "claude",
};

const baseCron = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  cron: "0 9 * * *",
  provider: "claude",
};

describe("parseScheduleCreateInput cwd/host validation", () => {
  test("no host, no cwd → defaults to process.cwd()", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("no host, with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, cwd: "/some/other/path" });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/some/other/path" },
    });
  });

  test("host with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      cwd: "/remote/project",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/remote/project" },
    });
  });

  test("host without cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required when --host is specified"),
      }),
    );
  });

  test("PASEO_HOST without cwd → throws MISSING_CWD", () => {
    const daemonTarget = selectDaemonTarget({}, { PASEO_HOST: "dev:12345" });

    expect(() => parseScheduleCreateInput({ ...baseOptions, daemonTarget })).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required"),
      }),
    );
  });

  test("explicit home beats PASEO_HOST and defaults cwd locally", () => {
    const daemonTarget = selectDaemonTarget({ home: process.cwd() }, { PASEO_HOST: "dev:12345" });
    expect(parseScheduleCreateInput({ ...baseOptions, daemonTarget }).target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("host with whitespace-only cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
        cwd: "   ",
      }),
    ).toThrow(expect.objectContaining({ code: "MISSING_CWD" }));
  });
});

describe("parseScheduleCreateInput first-run timing", () => {
  test("--every compiles to cron and waits for the next slot", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.cadence).toEqual({ type: "cron", expression: "*/5 * * * *" });
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with no run-now flag waits for the next cron slot", () => {
    const input = parseScheduleCreateInput(baseCron);
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with --run-now fires immediately on creation", () => {
    const input = parseScheduleCreateInput({ ...baseCron, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--cron with --timezone stores a timezone-aware cadence", () => {
    const input = parseScheduleCreateInput({
      ...baseCron,
      timezone: "  America/New_York  ",
    });

    expect(input.cadence).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("--run-now is orthogonal to a compiled preset", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--timezone without --cron is rejected", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({
        code: "INVALID_TIME_ZONE",
        message: "--timezone can only be used with --cron",
      }),
    );
  });
});

describe("parseScheduleCreateInput thinking", () => {
  test("sets the thinking option for each scheduled new-agent run", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      cwd: "/project",
      thinking: "  high  ",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/project",
        thinkingOptionId: "high",
      },
    });
  });
});

describe("parseScheduleCreateInput workspace", () => {
  test("--workspace leaves cwd to the workspace", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, workspace: "  wks_weekly  " });

    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", workspaceId: "wks_weekly" },
    });
  });

  test("--workspace keeps an explicit --cwd for the daemon to check", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      workspace: "wks_weekly",
      cwd: "/project",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", workspaceId: "wks_weekly", cwd: "/project" },
    });
  });

  test("--workspace replaces the --cwd requirement of --host", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      workspace: "wks_weekly",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", workspaceId: "wks_weekly" },
    });
  });

  test("rejects an empty --workspace", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, workspace: "  " })).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
  });

  test("rejects --workspace on an agent target", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        target: "11111111-1111-4111-8111-111111111111",
        workspace: "wks_weekly",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_TARGET" }));
  });
});

describe("schedule workspace support", () => {
  function clientWithFeatures(features: { scheduleWorkspaceTarget?: boolean } | null) {
    return {
      getLastServerInfoMessage: () => (features ? { features } : null),
    } as unknown as ScheduleDaemonClient;
  }

  test("accepts a host that advertises scheduleWorkspaceTarget", () => {
    expect(() =>
      requireScheduleWorkspaceSupport(clientWithFeatures({ scheduleWorkspaceTarget: true })),
    ).not.toThrow();
  });

  test.each([{}, { scheduleWorkspaceTarget: false }, null])(
    "asks to update a host that does not advertise it (%j)",
    (features) => {
      expect(() => requireScheduleWorkspaceSupport(clientWithFeatures(features))).toThrow(
        expect.objectContaining({
          code: "DAEMON_UPDATE_REQUIRED",
          message: "This host does not support running schedules in a workspace. Update the host.",
        }),
      );
    },
  );
});

describe("schedule workspace output", () => {
  const record: ScheduleRecord = {
    id: "abc12345",
    name: "weekly",
    prompt: "write the report",
    cadence: { type: "cron", expression: "0 12 * * 4" },
    target: {
      type: "new-agent",
      config: { provider: "claude", cwd: "/project", workspaceId: "wks_weekly" },
    },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
  };
  const unbound: ScheduleRecord = {
    ...record,
    target: { type: "new-agent", config: { provider: "claude", cwd: "/project" } },
  };

  test("ls rows carry the workspace, or null when the schedule creates its own", () => {
    expect(toScheduleRow(record).workspace).toBe("wks_weekly");
    expect(toScheduleRow(unbound).workspace).toBeNull();
  });

  test("heartbeats leave the workspace out of rows and columns", () => {
    const heartbeat: ScheduleRecord = {
      ...record,
      target: { type: "agent", agentId: "11111111-1111-4111-8111-111111111111" },
    };

    expect(toScheduleRow(heartbeat)).not.toHaveProperty("workspace");
    expect(scheduleSchema.columns.map((column) => column.field)).toContain("workspace");
    expect(heartbeatSchema.columns.map((column) => column.field)).not.toContain("workspace");
  });

  test("inspect lists the workspace row", () => {
    const workspaceRow = (schedule: ScheduleRecord) =>
      createScheduleInspectRows(schedule).find((row) => row.key === "Workspace");

    expect(workspaceRow(record)?.value).toBe("wks_weekly");
    expect(workspaceRow(unbound)?.value).toBe("null");
  });
});

describe("parseScheduleUpdateInput", () => {
  test("--workspace binds and --no-workspace clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", workspace: " wks_weekly " })).toEqual({
      id: "abc",
      newAgentConfig: { workspaceId: "wks_weekly" },
    });
    expect(parseScheduleUpdateInput({ id: "abc", clearWorkspace: true })).toEqual({
      id: "abc",
      newAgentConfig: { workspaceId: null },
    });
  });

  test("rejects passing both --workspace and --no-workspace", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", workspace: "wks_weekly", clearWorkspace: true }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_WORKSPACE" }));
  });

  test("rejects an empty --workspace", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", workspace: "  " })).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
  });

  test("rejects calls with no fields to update", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc" })).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });

  test("parses prompt and name updates", () => {
    expect(parseScheduleUpdateInput({ id: "abc", prompt: "  hello  ", name: "  named  " })).toEqual(
      {
        id: "abc",
        name: "named",
        prompt: "hello",
      },
    );
  });

  test("name set to empty string clears the name", () => {
    expect(parseScheduleUpdateInput({ id: "abc", name: "" })).toEqual({
      id: "abc",
      name: null,
    });
  });

  test("rejects empty prompt", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", prompt: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_PROMPT" }),
    );
  });

  test("compiles --every cadence to cron", () => {
    expect(parseScheduleUpdateInput({ id: "abc", every: "5m" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "*/5 * * * *" },
    });
  });

  test("parses --cron cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cron: "30 9 * * *" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
  });

  test("parses --cron cadence with --timezone", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        cron: "30 9 * * *",
        timezone: "Europe/Zurich",
      }),
    ).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *", timezone: "Europe/Zurich" },
    });
  });

  test("rejects passing both --every and --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", every: "5m", cron: "0 9 * * *" })).toThrow(
      expect.objectContaining({ code: "INVALID_CADENCE" }),
    );
  });

  test("rejects --timezone without --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({ code: "INVALID_TIME_ZONE" }),
    );
  });

  test("parses provider/model shorthand and explicit mode", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        provider: "codex/gpt-5",
        mode: "full-access",
        cwd: "/tmp/proj",
      }),
    ).toEqual({
      id: "abc",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/tmp/proj",
      },
    });
  });

  test("--mode with empty value clears the modeId", () => {
    expect(parseScheduleUpdateInput({ id: "abc", mode: "" })).toEqual({
      id: "abc",
      newAgentConfig: { modeId: null },
    });
  });

  test("rejects empty --cwd", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", cwd: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_CWD" }),
    );
  });

  test("--max-runs sets a positive integer; --no-max-runs clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", maxRuns: "3" })).toEqual({
      id: "abc",
      maxRuns: 3,
    });
    expect(parseScheduleUpdateInput({ id: "abc", clearMaxRuns: true })).toEqual({
      id: "abc",
      maxRuns: null,
    });
  });

  test("rejects passing both --max-runs and --no-max-runs", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", maxRuns: "3", clearMaxRuns: true })).toThrow(
      expect.objectContaining({ code: "CONFLICTING_MAX_RUNS" }),
    );
  });

  test("--expires-in computes an absolute timestamp; --no-expires-in clears", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(parseScheduleUpdateInput({ id: "abc", expiresIn: "1h" })).toEqual({
        id: "abc",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(parseScheduleUpdateInput({ id: "abc", clearExpires: true })).toEqual({
      id: "abc",
      expiresAt: null,
    });
  });

  test("rejects passing both --expires-in and --no-expires-in", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", expiresIn: "1h", clearExpires: true }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_EXPIRES" }));
  });
});

describe("compileEveryPresetToCron", () => {
  test.each([
    ["1m", "*/1 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["6h", "0 */6 * * *"],
    ["1d", "0 0 * * *"],
  ])("compiles %s", (value, expected) => {
    expect(compileEveryPresetToCron(value)).toBe(expected);
  });

  test.each(["30s", "7m", "5h", "2d"])("rejects rolling interval %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow(
      expect.objectContaining({ code: "UNREPRESENTABLE_CADENCE" }),
    );
  });

  test.each(["15minutes", "junk15m", "1h-nope"])("rejects malformed preset %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow("Invalid duration format");
  });
});
