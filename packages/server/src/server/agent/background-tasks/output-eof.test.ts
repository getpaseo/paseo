import { describe, expect, it } from "vitest";
import { resolveBackgroundTaskOutputEof } from "./output-eof.js";

describe("resolveBackgroundTaskOutputEof", () => {
  it("never EOFs live tasks without an output file", () => {
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: "running",
        hasOutputFile: false,
        caughtUp: true,
      }),
    ).toBe(false);
  });

  it("never EOFs live tasks that are only caught up on the current file size", () => {
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: "running",
        hasOutputFile: true,
        caughtUp: true,
      }),
    ).toBe(false);
  });

  it("EOFs terminal tasks once caught up or without a log file", () => {
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: "stopped",
        hasOutputFile: true,
        caughtUp: true,
      }),
    ).toBe(true);
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: "completed",
        hasOutputFile: false,
        caughtUp: true,
      }),
    ).toBe(true);
  });

  it("does not EOF terminal tasks until the tail is caught up", () => {
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: "failed",
        hasOutputFile: true,
        caughtUp: false,
      }),
    ).toBe(false);
  });

  it("EOFs unknown/missing tasks", () => {
    expect(
      resolveBackgroundTaskOutputEof({
        taskStatus: null,
        hasOutputFile: false,
        caughtUp: true,
      }),
    ).toBe(true);
  });
});
