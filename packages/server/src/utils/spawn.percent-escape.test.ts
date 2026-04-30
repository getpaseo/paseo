import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execCommand } from "./spawn.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeEchoArgScript(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-percent-escape-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "echo-arg.js");
  writeFileSync(scriptPath, "process.stdout.write(process.argv[2] ?? '');\n");
  return scriptPath;
}

// Use the bare command name "node" (no extension, no path separator) so
// `shouldUseWindowsShell` resolves to true on Windows. That routes the spawn
// through cmd.exe and exercises `quoteWindowsArgument`, which is where the
// %-doubling bug lives. Using `process.execPath` here would skip the shell
// path entirely and silently pass the test.
const COMMAND = "node";

describe("spawn argument escaping for % characters", () => {
  test("delivers a git for-each-ref --format atom to the child verbatim", async () => {
    const scriptPath = writeEchoArgScript();
    const formatArg = "--format=%(refname)%09%(committerdate:unix)";

    const { stdout } = await execCommand(COMMAND, [scriptPath, formatArg]);

    expect(stdout).toBe(formatArg);
  });

  test("delivers a bare percent-prefixed token to the child verbatim", async () => {
    const scriptPath = writeEchoArgScript();
    const arg = "%(refname)";

    const { stdout } = await execCommand(COMMAND, [scriptPath, arg]);

    expect(stdout).toBe(arg);
  });
});
