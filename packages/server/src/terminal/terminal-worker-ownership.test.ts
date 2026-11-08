import { describe, expect, it } from "vitest";
import type { ManagedProcessInspection } from "../server/managed-processes/managed-processes.js";
import {
  classifyTerminalProgramProcess,
  identifyTerminalWorker,
} from "./terminal-worker-ownership.js";

const BIRTH = "Wed Oct 21 18:12:49 2026";
const OTHER_BIRTH = "Wed Oct 21 18:13:02 2026";

function alive(startedAt: string | null, commandLine: string | null): ManagedProcessInspection {
  return { status: "alive", snapshot: { pid: 4242, startedAt, commandLine } };
}

describe("terminal program ownership", () => {
  it("owns a program that ran exec: same pid and birth time, new command line", () => {
    expect(
      classifyTerminalProgramProcess({ startedAt: BIRTH }, alive(BIRTH, "sleep 100000")),
    ).toEqual({ status: "owned" });
  });

  it("treats a reused pid with the same command line but another birth time as unrelated", () => {
    expect(
      classifyTerminalProgramProcess({ startedAt: BIRTH }, alive(OTHER_BIRTH, "/bin/zsh -l")),
    ).toMatchObject({ status: "unrelated" });
  });

  it("never owns a process without a birth time on either side, whatever its command", () => {
    expect(
      classifyTerminalProgramProcess({ startedAt: BIRTH }, alive(null, "/bin/zsh -l")),
    ).toMatchObject({ status: "unknown" });
    expect(
      classifyTerminalProgramProcess({ startedAt: null }, alive(BIRTH, "/bin/zsh -l")),
    ).toMatchObject({ status: "unknown" });
  });

  it("reports an inspection error as unknown, not gone", () => {
    expect(
      classifyTerminalProgramProcess(
        { startedAt: BIRTH },
        { status: "error", error: new Error("ps failed") },
      ),
    ).toMatchObject({ status: "unknown", reason: expect.stringContaining("ps failed") });
  });

  it("reports a missing process as gone", () => {
    expect(classifyTerminalProgramProcess({ startedAt: BIRTH }, { status: "not-found" })).toEqual({
      status: "gone",
    });
  });
});

describe("terminal worker ownership", () => {
  it("retires a live unrelated pid when its socket is absent without inspecting it", async () => {
    expect(
      await identifyTerminalWorker({
        pid: process.pid,
        socketPath:
          process.platform === "win32"
            ? "\\\\.\\pipe\\paseo-absent-ownership-test"
            : "/tmp/paseo-absent-ownership-test.sock",
      }),
    ).toEqual({ status: "gone" });
  });
});
