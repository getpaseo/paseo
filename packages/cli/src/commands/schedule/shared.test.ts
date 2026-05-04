import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { parseScheduleCreateInput, parseScheduleUpdateInput } from "./shared.js";

const baseOptions = {
  prompt: "do the thing",
  every: "5m",
  provider: "claude",
};

const baseCron = {
  prompt: "do the thing",
  cron: "0 9 * * *",
  provider: "claude",
};

describe("parseScheduleCreateInput cwd/host validation", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue("/local/project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no host, no cwd → defaults to process.cwd()", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/local/project" },
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
      host: "dev:6767",
      cwd: "/remote/project",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/remote/project" },
    });
  });

  test("host without cwd → throws MISSING_CWD", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, host: "dev:6767" })).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required when --host is specified"),
      }),
    );
  });

  test("host with whitespace-only cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({ ...baseOptions, host: "dev:6767", cwd: "   " }),
    ).toThrow(expect.objectContaining({ code: "MISSING_CWD" }));
  });
});

describe("parseScheduleCreateInput first-run timing", () => {
  test("--every with no run-now flag fires immediately on creation", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.runOnCreate).toBe(true);
  });

  test("--every with --no-run-now waits the interval", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, runNow: false });
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

  test("--every with --run-now is rejected as redundant", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, runNow: true })).toThrow(
      expect.objectContaining({
        code: "REDUNDANT_RUN_NOW",
        message: expect.stringContaining("--run-now is redundant with --every"),
      }),
    );
  });

  test("--cron with --no-run-now is rejected as redundant", () => {
    expect(() => parseScheduleCreateInput({ ...baseCron, runNow: false })).toThrow(
      expect.objectContaining({
        code: "REDUNDANT_NO_RUN_NOW",
        message: expect.stringContaining("--no-run-now is redundant with --cron"),
      }),
    );
  });
});

describe("parseScheduleUpdateInput", () => {
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

  test("parses --every cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", every: "5m" })).toEqual({
      id: "abc",
      cadence: { type: "every", everyMs: 5 * 60_000 },
    });
  });

  test("parses --cron cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cron: "30 9 * * *" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
  });

  test("rejects passing both --every and --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", every: "5m", cron: "0 9 * * *" })).toThrow(
      expect.objectContaining({ code: "INVALID_CADENCE" }),
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
