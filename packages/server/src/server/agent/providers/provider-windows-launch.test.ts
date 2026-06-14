import type { ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { PiCliRuntime } from "./pi/cli-runtime.js";

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

interface ProviderLaunchCase {
  provider: "claude" | "codex" | "opencode" | "generic-acp" | "pi";
  binaryName: string;
  args: string[];
  shell?: boolean;
  launchMode?: "spawnProcess" | "piRuntime";
}

const JSON_ARG = '{"mcpServers":{"paseo":{"type":"http","url":"http://127.0.0.1:6767/mcp"}}}';
const tempDirs: string[] = [];

function makeFixture(
  binaryName: string,
  expectedArgs: string[],
  launchMode: "spawnProcess" | "piRuntime" = "spawnProcess",
) {
  const root = mkdtempSync(path.join(tmpdir(), `paseo ${binaryName} launch `));
  tempDirs.push(root);

  const fakeDaemonNode = path.join(root, "Fake Paseo.exe");
  copyFileSync(process.execPath, fakeDaemonNode);

  const assertScript = path.join(root, "assert-argv.js");
  writeFileSync(
    assertScript,
    `
if (process.argv.includes("--version")) {
  console.log("fake-provider 1.0.0");
  process.exit(0);
}

const expected = ${JSON.stringify(expectedArgs)};
const actual = process.argv.slice(2);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("ARGV_MISMATCH");
  console.error(JSON.stringify({ expected, actual }));
  process.exit(42);
}
if (${JSON.stringify(launchMode)} === "piRuntime") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf("\\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      const command = JSON.parse(line);
      if (command.type === "get_state") {
        process.stdout.write(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: {
              sessionId: "pi-session-1",
              thinkingLevel: "medium",
              isStreaming: false,
              isCompacting: false,
              messageCount: 0,
              pendingMessageCount: 0,
            },
          }) + "\\n",
        );
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  console.log("ARGV_OK");
}
`,
  );

  const shim = path.join(root, `${binaryName}.cmd`);
  writeFileSync(
    shim,
    ["@echo off", "setlocal", `"${fakeDaemonNode}" "${assertScript}" %*`, ""].join("\r\n"),
  );

  return { root, shim, expectedArgs };
}

function collectChild(child: ChildProcess, timeoutMs = 10_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let pendingResolve: ((value: SpawnResult) => void) | null = resolve;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let error: Error | null = null;

    const settle = (result: Pick<SpawnResult, "code" | "signal">) => {
      if (!pendingResolve) {
        return;
      }
      const fn = pendingResolve;
      pendingResolve = null;
      clearTimeout(timer);
      fn({
        ...result,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error,
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ code: null, signal: "SIGKILL" });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (err) => {
      error = err;
      settle({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      settle({ code, signal });
    });
  });
}

async function runProviderFixture(params: {
  command: string;
  args: string[];
  expectedArgs: string[];
  shell?: boolean;
}): Promise<SpawnResult> {
  const child = spawnProcess(params.command, params.args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(params.shell === undefined ? {} : { shell: params.shell }),
  });
  return collectChild(child);
}

async function runPiRuntimeFixture(params: { command: string; cwd: string }): Promise<void> {
  const runtime = new PiCliRuntime({
    logger: pino({ level: "silent" }),
    command: [params.command],
  });
  const session = await runtime.startSession({ cwd: params.cwd });

  try {
    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "pi-session-1",
      thinkingLevel: "medium",
    });
  } finally {
    await session.close();
  }
}

function withPathEntry<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const pathKey =
    process.platform === "win32"
      ? (Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path")
      : "PATH";
  const previousPath = process.env[pathKey];
  process.env[pathKey] = previousPath ? `${dir}${path.delimiter}${previousPath}` : dir;

  return run().finally(() => {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const providerLaunchCases: ProviderLaunchCase[] = [
  {
    provider: "claude",
    binaryName: "claude",
    args: ["--mcp-config", JSON_ARG],
    shell: false,
  },
  {
    provider: "codex",
    binaryName: "codex",
    args: ["app-server", "--config", JSON_ARG],
  },
  {
    provider: "opencode",
    binaryName: "opencode",
    args: ["serve", "--port", "49271", "--config", JSON_ARG],
  },
  {
    provider: "generic-acp",
    binaryName: "generic-acp",
    args: ["--mcp-config", JSON_ARG],
  },
  {
    provider: "pi",
    binaryName: "pi",
    args: ["--mode", "rpc"],
    launchMode: "piRuntime",
  },
];

describe.runIf(process.platform === "win32")("Windows provider launch parity", () => {
  test("detected claude.cmd can be launched with Claude's JSON-safe spawn shape", async () => {
    const args = ["--mcp-config", JSON_ARG];
    const fixture = makeFixture("claude", args);

    await withPathEntry(fixture.root, async () => {
      const detected = await findExecutable("claude");
      expect(detected?.toLowerCase()).toBe(fixture.shim.toLowerCase());

      const result = await runProviderFixture({
        command: detected!,
        args,
        expectedArgs: args,
        shell: false,
      });

      expect(result.error).toBeNull();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ARGV_OK");
    });
  });

  test.each(providerLaunchCases)(
    "$provider launches a cmd shim from a path with spaces through its Windows-safe launch path",
    async ({ binaryName, args, shell, launchMode }) => {
      const fixture = makeFixture(binaryName, args, launchMode);

      if (launchMode === "piRuntime") {
        await runPiRuntimeFixture({
          command: fixture.shim,
          cwd: fixture.root,
        });
        return;
      }

      const result = await runProviderFixture({
        command: fixture.shim,
        args: fixture.expectedArgs,
        expectedArgs: fixture.expectedArgs,
        shell,
      });

      expect(result.error).toBeNull();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("ARGV_OK");
    },
  );
});
