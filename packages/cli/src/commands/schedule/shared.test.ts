import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { parseScheduleCreateInput } from "./shared.js";

const baseOptions = {
  prompt: "do the thing",
  every: "5m",
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
