import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { parseScheduleCreateInput } from "./shared.js";

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
