import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { execCommand, spawnProcess } from "./spawn.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeEchoArgScript(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-multiline-argument-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "echo-arg.js");
  writeFileSync(scriptPath, "process.stdout.write(process.argv[2] ?? '');\n");
  return scriptPath;
}

// Use the bare command name "node" (no extension, no path separator) because
// that is the shape `shouldUseWindowsShell` routes through cmd.exe, which drops
// everything after the first newline in an argument. Using `process.execPath`
// here would skip the shell path entirely and silently pass the test.
const COMMAND = "node";

const GRAPHQL_QUERY = "query PaseoBatchPullRequestStatus {\n  rateLimit {\n    remaining\n  }\n}";
const COMMIT_MESSAGE = "subject line\r\n\r\nbody paragraph";

describe("spawn argument delivery for multi-line arguments", () => {
  test("delivers a multi-line gh graphql query to the child verbatim", async () => {
    const scriptPath = writeEchoArgScript();

    const { stdout } = await execCommand(COMMAND, [scriptPath, GRAPHQL_QUERY]);

    expect(stdout).toBe(GRAPHQL_QUERY);
  });

  test("delivers a carriage-return commit message to the child verbatim", async () => {
    const scriptPath = writeEchoArgScript();

    const { stdout } = await execCommand(COMMAND, [scriptPath, COMMIT_MESSAGE]);

    expect(stdout).toBe(COMMIT_MESSAGE);
  });

  test("spawnProcess delivers a multi-line argument to the child verbatim", async () => {
    const scriptPath = writeEchoArgScript();
    const child = spawnProcess(COMMAND, [scriptPath, GRAPHQL_QUERY]);

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe(GRAPHQL_QUERY);
  });
});
