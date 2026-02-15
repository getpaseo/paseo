import { describe, expect, it } from "vitest";

import {
  getTerminalResumeOffset,
  getTerminalAttachRetryDelayMs,
  isTerminalAttachRetryableError,
  updateTerminalResumeOffset,
  withPromiseTimeout,
} from "./terminal-attach";

describe("terminal-attach", () => {
  it("computes bounded exponential retry delays", () => {
    expect(getTerminalAttachRetryDelayMs({ attempt: 0 })).toBe(250);
    expect(getTerminalAttachRetryDelayMs({ attempt: 1 })).toBe(500);
    expect(getTerminalAttachRetryDelayMs({ attempt: 2 })).toBe(1_000);
    expect(getTerminalAttachRetryDelayMs({ attempt: 3 })).toBe(2_000);
    expect(getTerminalAttachRetryDelayMs({ attempt: 8 })).toBe(2_000);
  });

  it("matches retryable attach errors", () => {
    expect(
      isTerminalAttachRetryableError({ message: "Terminal not found while attaching" })
    ).toBe(true);
    expect(
      isTerminalAttachRetryableError({ message: "Network disconnected during attach" })
    ).toBe(true);
    expect(
      isTerminalAttachRetryableError({ message: "stream ended before ack" })
    ).toBe(true);
    expect(
      isTerminalAttachRetryableError({ message: "permission denied" })
    ).toBe(false);
  });

  it("reads and updates resume offsets monotonically", () => {
    const offsets = new Map<string, number>();
    const terminalId = "term-1";

    expect(
      getTerminalResumeOffset({
        terminalId,
        resumeOffsetByTerminalId: offsets,
      })
    ).toBeUndefined();

    updateTerminalResumeOffset({
      terminalId,
      offset: 8,
      resumeOffsetByTerminalId: offsets,
    });
    expect(
      getTerminalResumeOffset({
        terminalId,
        resumeOffsetByTerminalId: offsets,
      })
    ).toBe(8);

    // Stale offsets must not move resume backwards.
    updateTerminalResumeOffset({
      terminalId,
      offset: 3,
      resumeOffsetByTerminalId: offsets,
    });
    expect(
      getTerminalResumeOffset({
        terminalId,
        resumeOffsetByTerminalId: offsets,
      })
    ).toBe(8);
  });

  it("resolves before timeout when promise completes", async () => {
    await expect(
      withPromiseTimeout({
        promise: Promise.resolve("ok"),
        timeoutMs: 50,
        timeoutMessage: "timed out",
      })
    ).resolves.toBe("ok");
  });

  it("rejects when timeout wins", async () => {
    await expect(
      withPromiseTimeout({
        promise: new Promise<string>(() => {}),
        timeoutMs: 10,
        timeoutMessage: "timed out",
      })
    ).rejects.toThrow("timed out");
  });
});
