import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "./local-shell-tools.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hubcode-sh-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("captures stdout on success", async () => {
    const r = await runCommand({ cwd: tmp, command: "echo hello" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("");
    expect(r.timedOut).toBe(false);
  });

  it("captures stderr separately from stdout", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "echo out; echo err 1>&2",
    });
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
  });

  it("returns non-zero exit code on failure", async () => {
    const r = await runCommand({ cwd: tmp, command: "exit 7" });
    expect(r.exitCode).toBe(7);
  });

  it("runs in the given cwd", async () => {
    await fs.writeFile(path.join(tmp, "marker.txt"), "x");
    const r = await runCommand({ cwd: tmp, command: "ls" });
    expect(r.stdout).toContain("marker.txt");
  });

  it("inherits environment variables from process.env", async () => {
    process.env.HUBCODE_TEST_INHERIT = "value-from-parent";
    try {
      const r = await runCommand({
        cwd: tmp,
        command: "echo $HUBCODE_TEST_INHERIT",
      });
      expect(r.stdout).toBe("value-from-parent\n");
    } finally {
      delete process.env.HUBCODE_TEST_INHERIT;
    }
  });

  it("merges custom env over process.env", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "echo $MY_VAR",
      env: { MY_VAR: "custom" },
    });
    expect(r.stdout).toBe("custom\n");
  });

  it("kills the process and flags timedOut when over the timeout", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "sleep 5",
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    // Killed by SIGKILL — exitCode is null on most platforms (signal
    // termination), we just assert it didn't reach exit 0.
    expect(r.exitCode).not.toBe(0);
    // Must have terminated well before the 5s sleep would have.
    expect(r.durationMs).toBeLessThan(2000);
  });

  it("truncates stdout past maxBytes and flags it", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "printf 'abcdefghij'",
      maxBytes: 4,
    });
    expect(r.stdout).toBe("abcd");
    expect(r.stdoutTruncated).toBe(true);
  });

  it("truncates stderr past maxBytes and flags it", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "printf 'abcdefghij' 1>&2",
      maxBytes: 3,
    });
    expect(r.stderr).toBe("abc");
    expect(r.stderrTruncated).toBe(true);
  });

  it("reports duration", async () => {
    const r = await runCommand({ cwd: tmp, command: "sleep 0.1" });
    expect(r.durationMs).toBeGreaterThanOrEqual(100);
  });

  it("supports shell pipes and redirects", async () => {
    const r = await runCommand({
      cwd: tmp,
      command: "echo 'a b c' | wc -w",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("3");
  });
});
