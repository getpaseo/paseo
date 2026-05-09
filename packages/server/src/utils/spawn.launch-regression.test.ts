import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

import { findExecutable } from "./executable.js";
import { spawnProcess } from "./spawn.js";
import { isPlatform } from "../test-utils/platform.js";

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

const tempDirs: string[] = [];
const JSON_ARG = '{"key":"value with spaces","nested":{"quote":"\\"yes\\""}}';

const ASSERT_SCRIPT_BODY = `
if (process.argv.includes("--version")) {
  console.log("fake-cli 1.0.0");
  process.exit(0);
}
const expected = JSON.parse(process.env.PASEO_EXPECTED_ARGV_JSON);
const sliceFrom = process.env.PASEO_ARGV_SLICE_FROM ? Number(process.env.PASEO_ARGV_SLICE_FROM) : 2;
const actual = process.argv.slice(sliceFrom);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("ARGV_MISMATCH");
  console.error(JSON.stringify({ expected, actual }));
  process.exit(42);
}
console.log("LAUNCH_OK");
`;

function makeFixture(): {
  root: string;
  fakeDaemonNode: string;
  shim: string;
  assertScript: string;
  expectedArgs: string[];
} {
  const root = mkdtempSync(path.join(tmpdir(), "paseo spawn regression "));
  tempDirs.push(root);

  const fakeDaemonNode = path.join(root, "Fake Paseo.exe");
  copyFileSync(process.execPath, fakeDaemonNode);

  const expectedArgs = ["--config", JSON_ARG];
  const assertScript = path.join(root, "assert-argv.js");
  writeFileSync(
    assertScript,
    `
if (process.argv.includes("--version")) {
  console.log("fake-provider 1.0.0");
  process.exit(0);
}

const expected = JSON.parse(process.env.PASEO_EXPECTED_ARGV_JSON);
const actual = process.argv.slice(2);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("ARGV_MISMATCH");
  console.error(JSON.stringify({ expected, actual }));
  process.exit(42);
}
console.log("ARGV_OK");
`,
  );

  const shim = path.join(root, "claude.cmd");
  writeFileSync(
    shim,
    ["@echo off", "setlocal", `"${fakeDaemonNode}" "${assertScript}" %*`, ""].join("\r\n"),
  );

  return { root, fakeDaemonNode, shim, assertScript, expectedArgs };
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

async function runFixture(params: {
  command: string;
  args: string[];
  shell?: boolean;
}): Promise<SpawnResult> {
  const child = spawnProcess(params.command, params.args, {
    env: {
      ...process.env,
      PASEO_EXPECTED_ARGV_JSON: JSON.stringify(["--config", JSON_ARG]),
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...(params.shell === undefined ? {} : { shell: params.shell }),
  });
  return collectChild(child);
}

interface LaunchFixture {
  root: string;
  command: string;
  binaryPath: string;
  args: string[];
  expectedArgvJson: string;
  sliceFrom: number;
}

function makeLaunchFixture(ext: "exe" | "cmd" | "bat"): LaunchFixture {
  const root = mkdtempSync(path.join(tmpdir(), `paseo-launch-${ext}-`));
  tempDirs.push(root);

  // Unique base name so a globally installed binary cannot satisfy findExecutable.
  const command = `paseo-launch-fake-${path.basename(root)}`;
  const userArgs = ["--config", JSON_ARG];
  const expectedArgvJson = JSON.stringify(userArgs);

  if (ext === "exe") {
    // Copy node.exe to <command>.exe and run our assert body via -e.
    // The `--` separator stops Node from parsing userArgs as Node options
    // (e.g. `--config` would otherwise trigger "bad option" → exit 9).
    // With -e there is no script slot, so process.argv = [node, ...userArgs] → slice(1).
    const binaryPath = path.join(root, `${command}.exe`);
    copyFileSync(process.execPath, binaryPath);
    return {
      root,
      command,
      binaryPath,
      args: ["-e", ASSERT_SCRIPT_BODY, "--", ...userArgs],
      expectedArgvJson,
      sliceFrom: 1,
    };
  }

  // .cmd / .bat: a shim that invokes node with our assert script.
  // process.argv = [node, scriptPath, ...userArgs] → slice(2).
  const fakeNode = path.join(root, "Fake Node.exe");
  copyFileSync(process.execPath, fakeNode);
  const assertScript = path.join(root, "assert-argv.js");
  writeFileSync(assertScript, ASSERT_SCRIPT_BODY);

  const binaryPath = path.join(root, `${command}.${ext}`);
  writeFileSync(
    binaryPath,
    ["@echo off", "setlocal", `"${fakeNode}" "${assertScript}" %*`, ""].join("\r\n"),
  );
  return { root, command, binaryPath, args: userArgs, expectedArgvJson, sliceFrom: 2 };
}

function withPathPrepended<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const pathKey = isPlatform("win32")
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

async function findAndLaunch(fixture: LaunchFixture): Promise<{
  found: string | null;
  result: SpawnResult | null;
}> {
  return withPathPrepended(fixture.root, async () => {
    const found = await findExecutable(fixture.command);
    if (found === null) {
      return { found: null, result: null };
    }

    const child = spawnProcess(found, fixture.args, {
      env: {
        ...process.env,
        PASEO_EXPECTED_ARGV_JSON: fixture.expectedArgvJson,
        PASEO_ARGV_SLICE_FROM: String(fixture.sliceFrom),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { found, result: await collectChild(child) };
  });
}

function expectWindowsPathsEqual(actual: string, expected: string): void {
  if (isPlatform("win32")) {
    expect(actual.toLowerCase()).toBe(expected.toLowerCase());
  } else {
    expect(actual).toBe(expected);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe.runIf(isPlatform("win32"))("Windows spawn launch regression", () => {
  test("launches a cmd shim from a path with spaces without corrupting JSON args", async () => {
    const fixture = makeFixture();

    const result = await runFixture({
      command: fixture.shim,
      args: fixture.expectedArgs,
    });

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ARGV_OK");
  });

  test("launches a cmd shim even when the caller explicitly disables shell", async () => {
    const fixture = makeFixture();

    const result = await runFixture({
      command: fixture.shim,
      args: fixture.expectedArgs,
      shell: false,
    });

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ARGV_OK");
  });

  test("direct launch with a space-containing executable preserves JSON args", async () => {
    const fixture = makeFixture();

    const result = await runFixture({
      command: fixture.fakeDaemonNode,
      args: [fixture.assertScript, ...fixture.expectedArgs],
      shell: false,
    });

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ARGV_OK");
  });

  test("finds a .exe on PATH and launches it via spawnProcess", async () => {
    const fixture = makeLaunchFixture("exe");
    const { found, result } = await findAndLaunch(fixture);

    expect(found).not.toBeNull();
    expectWindowsPathsEqual(found!, fixture.binaryPath);
    expect(result).not.toBeNull();
    expect(result!.error).toBeNull();
    expect(result!.code).toBe(0);
    expect(result!.signal).toBeNull();
    expect(result!.stderr).toBe("");
    expect(result!.stdout.trim()).toBe("LAUNCH_OK");
  });

  test("finds a .cmd on PATH and launches it via spawnProcess", async () => {
    const fixture = makeLaunchFixture("cmd");
    const { found, result } = await findAndLaunch(fixture);

    expect(found).not.toBeNull();
    expectWindowsPathsEqual(found!, fixture.binaryPath);
    expect(result).not.toBeNull();
    expect(result!.error).toBeNull();
    expect(result!.code).toBe(0);
    expect(result!.signal).toBeNull();
    expect(result!.stderr).toBe("");
    expect(result!.stdout.trim()).toBe("LAUNCH_OK");
  });

  test("finds a .bat on PATH and launches it via spawnProcess", async () => {
    const fixture = makeLaunchFixture("bat");
    const { found, result } = await findAndLaunch(fixture);

    expect(found).not.toBeNull();
    expectWindowsPathsEqual(found!, fixture.binaryPath);
    expect(result).not.toBeNull();
    expect(result!.error).toBeNull();
    expect(result!.code).toBe(0);
    expect(result!.signal).toBeNull();
    expect(result!.stderr).toBe("");
    expect(result!.stdout.trim()).toBe("LAUNCH_OK");
  });
});

describe.skipIf(isPlatform("win32"))("spawn launch regression smoke", () => {
  test("direct launch with a space-containing executable works on this platform", async () => {
    const fixture = makeFixture();

    const result = await runFixture({
      command: fixture.fakeDaemonNode,
      args: [fixture.assertScript, ...fixture.expectedArgs],
      shell: false,
    });

    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ARGV_OK");
  });
});
