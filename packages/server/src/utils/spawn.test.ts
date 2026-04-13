import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execCommand } from "./spawn.js";

describe("execCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns stdout and stderr for a successful command", async () => {
    await expect(execCommand("echo", ["hello"])).resolves.toEqual({
      stdout: "hello\n",
      stderr: "",
    });
  });

  test("rejects when the command times out", async () => {
    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10_000)"],
          }
        : { command: "sleep", args: ["10"] };

    await expect(execCommand(command.command, command.args, { timeout: 100 })).rejects.toThrow();
  });

  test("runs the command in the provided cwd", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-test-")));
    tempDirs.push(cwd);

    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "console.log(process.cwd())"],
          }
        : { command: "pwd", args: [] };

    await expect(execCommand(command.command, command.args, { cwd })).resolves.toEqual({
      stdout: `${cwd}\n`,
      stderr: "",
    });
  });
});
