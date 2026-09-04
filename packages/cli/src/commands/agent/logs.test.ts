import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, test } from "vitest";

import { parseTailCount, planAgentLogsRequest } from "./logs.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));

function runCli(args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/index.ts", ...args],
      { cwd: repoRoot },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code, stderr, stdout });
    });
  });
}

test("rejects malformed tail input before command execution", () => {
  expect(parseTailCount("-1")).toBeNull();
  expect(parseTailCount("10items")).toBeNull();
  expect(parseTailCount("9007199254740992")).toBeNull();
  expect(parseTailCount("10")).toBe(10);
});

test("plans non-follow --tail 0 without a daemon connection", () => {
  expect(planAgentLogsRequest({ tail: "0" })).toEqual({
    isValid: true,
    tailCount: 0,
    shouldConnect: false,
    shouldFetchInitialHistory: false,
  });
});

test("plans follow --tail 0 to connect without fetching history", () => {
  expect(planAgentLogsRequest({ follow: true, tail: "0" })).toEqual({
    isValid: true,
    tailCount: 0,
    shouldConnect: true,
    shouldFetchInitialHistory: false,
  });
});

test("runs non-follow --tail 0 without a daemon", async () => {
  const result = await runCli([
    "agent",
    "logs",
    "no-such-agent",
    "--tail",
    "0",
    "--host",
    "127.0.0.1:1",
  ]);

  expect(result).toEqual({ code: 0, stderr: "", stdout: "" });
});
