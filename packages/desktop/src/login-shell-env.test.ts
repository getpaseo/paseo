import type { SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inheritLoginShellEnv } from "./login-shell-env";

const zsh = "/bin/zsh";
const describeIfZsh = existsSync(zsh) ? describe : describe.skip;
const basePath = "/usr/bin:/bin:/usr/sbin:/sbin";
const fakeHome = path.join(os.tmpdir(), "paseo-login-shell-env-fake-home");
type LoginShellEnvInput = NonNullable<Parameters<typeof inheritLoginShellEnv>[0]>;
type LoginShellSpawnSync = NonNullable<LoginShellEnvInput["spawnSync"]>;

interface TestClock {
  advance: (ms: number) => void;
  now: () => number;
}

interface RecordedLog {
  message: string;
  fields: Record<string, unknown>;
}

interface RecordedSpawn {
  argv0: string | undefined;
  shell: string;
  args: string[];
  timeoutMs: number | undefined;
}

interface SpawnResultFields {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

class RecordingLoginShellLogger {
  readonly infos: RecordedLog[] = [];
  readonly warnings: RecordedLog[] = [];

  info(message: string, fields: Record<string, unknown>): void {
    this.infos.push({ message, fields });
  }

  warn(message: string, fields: Record<string, unknown>): void {
    this.warnings.push({ message, fields });
  }
}

function createEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USER: "paseo-test",
    LOGNAME: "paseo-test",
    SHELL: zsh,
    PATH: basePath,
  };
}

function createTestClock(): TestClock {
  let currentMs = 1_000;
  return {
    advance: (ms: number) => {
      currentMs += ms;
    },
    now: () => currentMs,
  };
}

function spawnResult(fields: SpawnResultFields): SpawnSyncReturns<string> {
  const stdout = fields.stdout ?? "";
  const stderr = fields.stderr ?? "";
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: fields.status === undefined ? 0 : fields.status,
    signal: fields.signal ?? null,
    error: fields.error,
  } satisfies SpawnSyncReturns<string>;
}

function successResult(shellCommand: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const marker = markerFromShellCommand(shellCommand);
  const stdout = `${marker}${JSON.stringify(env)}${marker}`;
  return spawnResult({ stdout });
}

function shellArgsFromRecordedCall(call: RecordedSpawn | undefined): string[] {
  if (!call) return [];
  return call.args.slice(0, -1);
}

function markerFromShellCommand(shellCommand: string): string {
  const match = /"([0-9a-f]{12})" \+ JSON\.stringify\(process\.env\) \+ "\1"/.exec(shellCommand);
  if (!match?.[1]) throw new Error(`missing env marker in shell command: ${shellCommand}`);
  return match[1];
}

function expectNoRawStdout(fields: Record<string, unknown>): void {
  expect(fields).not.toHaveProperty("stdout");
}

async function createShellHome(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "paseo-login-shell-env-"));
}

describe("login shell env retry behavior", () => {
  it("applies the interactive env without retrying", () => {
    const env = createEnv(fakeHome);
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const interactivePath = "/interactive/bin:/usr/bin:/bin";
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });
      clock.advance(5);
      return successResult(String(recordedArgs.at(-1)), { ...env, PATH: interactivePath });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(interactivePath);
    expect(calls).toHaveLength(1);
    expect(shellArgsFromRecordedCall(calls[0])).toEqual(["-i", "-l", "-c"]);
    expect(calls[0]?.timeoutMs).toBe(15_000);
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "[login-shell-env] start",
      "[login-shell-env] attempt applied",
      "[login-shell-env] applied",
    ]);
    expect(logger.infos[1]?.fields).toMatchObject({
      attemptKind: "interactive",
      shellArgs: ["-i", "-l", "-c"],
      reason: "success",
      timeoutMs: 15_000,
    });
    expect(logger.infos[2]?.fields).toMatchObject({
      attemptKind: "interactive",
      durationMs: 5,
      timeoutMs: 30_000,
      beforePath: basePath,
      afterPath: interactivePath,
      pathChanged: true,
    });
    expect(logger.warnings).toEqual([]);
  });

  it("retries non-interactively after an interactive timeout", () => {
    const env = createEnv(fakeHome);
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const nonInteractivePath = "/login/bin:/usr/bin:/bin";
    const timeoutError = Object.assign(new Error("spawnSync ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    let timedOutStdout = "";
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });

      if (calls.length === 1) {
        const marker = markerFromShellCommand(String(recordedArgs.at(-1)));
        timedOutStdout = `${marker}${JSON.stringify({ ...env, PATH: "/timed-out/bin" })}${marker}`;
        clock.advance(15_000);
        return spawnResult({
          stdout: timedOutStdout,
          status: null,
          signal: "SIGTERM",
          error: timeoutError,
        });
      }

      clock.advance(3);
      return successResult(String(recordedArgs.at(-1)), { ...env, PATH: nonInteractivePath });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(nonInteractivePath);
    expect(calls).toHaveLength(2);
    expect(shellArgsFromRecordedCall(calls[0])).toEqual(["-i", "-l", "-c"]);
    expect(shellArgsFromRecordedCall(calls[1])).toEqual(["-l", "-c"]);
    expect(calls[0]?.timeoutMs).toBe(15_000);
    expect(calls[1]?.timeoutMs).toBe(15_000);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe("[login-shell-env] attempt failed; retrying");
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "timeout",
      attemptKind: "interactive",
      shellArgs: ["-i", "-l", "-c"],
      status: null,
      signal: "SIGTERM",
      stdoutLength: timedOutStdout.length,
      markerFound: true,
      errorCode: "ETIMEDOUT",
      durationMs: 15_000,
      timeoutMs: 15_000,
    });
    expect(logger.infos[1]?.fields).toMatchObject({
      attemptKind: "non-interactive",
      shellArgs: ["-l", "-c"],
      reason: "success",
      durationMs: 3,
      timeoutMs: 15_000,
    });
    expect(logger.infos[2]?.fields).toMatchObject({
      attemptKind: "non-interactive",
      durationMs: 15_003,
      timeoutMs: 30_000,
      beforePath: basePath,
      afterPath: nonInteractivePath,
      pathChanged: true,
    });
    expectNoRawStdout(logger.warnings[0]?.fields ?? {});
  });

  it("retries non-interactively when the interactive marker is missing", () => {
    const env = createEnv(fakeHome);
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const nonInteractivePath = "/profile/bin:/usr/bin:/bin";
    const missingMarkerStdout = "switched shells before command\n";
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });

      if (calls.length === 1) {
        clock.advance(25);
        return spawnResult({ stdout: missingMarkerStdout });
      }

      clock.advance(2);
      return successResult(String(recordedArgs.at(-1)), { ...env, PATH: nonInteractivePath });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(nonInteractivePath);
    expect(calls).toHaveLength(2);
    expect(shellArgsFromRecordedCall(calls[0])).toEqual(["-i", "-l", "-c"]);
    expect(shellArgsFromRecordedCall(calls[1])).toEqual(["-l", "-c"]);
    expect(calls[0]?.timeoutMs).toBe(15_000);
    expect(calls[1]?.timeoutMs).toBe(29_975);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe("[login-shell-env] attempt failed; retrying");
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "marker-missing",
      attemptKind: "interactive",
      shellArgs: ["-i", "-l", "-c"],
      status: 0,
      signal: null,
      stdoutLength: missingMarkerStdout.length,
      markerFound: false,
      durationMs: 25,
      timeoutMs: 15_000,
    });
    expect(logger.infos[1]?.fields).toMatchObject({
      attemptKind: "non-interactive",
      reason: "success",
      durationMs: 2,
      timeoutMs: 29_975,
    });
    expectNoRawStdout(logger.warnings[0]?.fields ?? {});
  });

  it("keeps the inherited env after both attempts fail", () => {
    const env = createEnv(fakeHome);
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const spawnError = Object.assign(new Error("spawnSync ENOENT"), {
      code: "ENOENT",
    });
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });

      if (calls.length === 1) {
        clock.advance(10);
        return spawnResult({ stdout: "no marker\n" });
      }

      clock.advance(5);
      return spawnResult({
        status: null,
        signal: null,
        error: spawnError,
      });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(basePath);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.timeoutMs).toBe(15_000);
    expect(calls[1]?.timeoutMs).toBe(29_990);
    expect(logger.infos.map((entry) => entry.message)).toEqual(["[login-shell-env] start"]);
    expect(logger.warnings.map((entry) => entry.message)).toEqual([
      "[login-shell-env] attempt failed; retrying",
      "[login-shell-env] attempt failed",
      "[login-shell-env] failed; keeping inherited env",
    ]);
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "marker-missing",
      attemptKind: "interactive",
      shellArgs: ["-i", "-l", "-c"],
      durationMs: 10,
      timeoutMs: 15_000,
    });
    expect(logger.warnings[1]?.fields).toMatchObject({
      reason: "spawn-error",
      attemptKind: "non-interactive",
      shellArgs: ["-l", "-c"],
      durationMs: 5,
      errorCode: "ENOENT",
      timeoutMs: 29_990,
    });
    expect(logger.warnings[2]?.fields).toMatchObject({
      reason: "spawn-error",
      attemptKind: "non-interactive",
      shellArgs: ["-l", "-c"],
      errorCode: "ENOENT",
      durationMs: 15,
      timeoutMs: 30_000,
      beforePath: basePath,
      afterPath: basePath,
      pathChanged: false,
    });
    expectNoRawStdout(logger.warnings[2]?.fields ?? {});
  });

  it("uses the configured shell env timeout", () => {
    const env = {
      ...createEnv(fakeHome),
      PASEO_SHELL_ENV_TIMEOUT_MS: "1234",
    };
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const configuredPath = "/configured/bin:/usr/bin:/bin";
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });
      clock.advance(4);
      return successResult(String(recordedArgs.at(-1)), { ...env, PATH: configuredPath });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(configuredPath);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(617);
    expect(logger.infos[0]?.fields).toMatchObject({
      timeoutMs: 1234,
    });
    expect(logger.infos[1]?.fields).toMatchObject({
      timeoutMs: 617,
    });
    expect(logger.infos[2]?.fields).toMatchObject({
      durationMs: 4,
      timeoutMs: 1234,
    });
  });

  it("uses argv0 for the non-interactive tcsh login retry", () => {
    const env = {
      ...createEnv(fakeHome),
      SHELL: "/bin/tcsh",
    };
    const logger = new RecordingLoginShellLogger();
    const clock = createTestClock();
    const calls: RecordedSpawn[] = [];
    const nonInteractivePath = "/tcsh/login/bin:/usr/bin:/bin";
    const spawnSync: LoginShellSpawnSync = (shell, args, options) => {
      const recordedArgs = Array.isArray(args) ? args.map(String) : [];
      calls.push({
        argv0: options?.argv0,
        shell: String(shell),
        args: recordedArgs,
        timeoutMs: options?.timeout,
      });

      if (calls.length === 1) {
        clock.advance(8);
        return spawnResult({ stdout: "no marker\n" });
      }

      clock.advance(2);
      return successResult(String(recordedArgs.at(-1)), { ...env, PATH: nonInteractivePath });
    };

    inheritLoginShellEnv({ env, logger, now: clock.now, platform: "darwin", spawnSync });

    expect(env.PATH).toBe(nonInteractivePath);
    expect(calls).toHaveLength(2);
    expect(shellArgsFromRecordedCall(calls[0])).toEqual(["-ic"]);
    expect(calls[0]?.argv0).toBeUndefined();
    expect(shellArgsFromRecordedCall(calls[1])).toEqual(["-c"]);
    expect(calls[1]?.argv0).toBe("-tcsh");
    expect(calls[1]?.timeoutMs).toBe(29_992);
    expect(logger.warnings[0]?.fields).toMatchObject({
      attemptKind: "interactive",
      shellArgs: ["-ic"],
      reason: "marker-missing",
      timeoutMs: 15_000,
    });
    expect(logger.infos[1]?.fields).toMatchObject({
      attemptKind: "non-interactive",
      argv0: "-tcsh",
      shellArgs: ["-c"],
      reason: "success",
      timeoutMs: 29_992,
    });
  });
});

describeIfZsh("login shell env", () => {
  const homes = new Set<string>();

  afterEach(async () => {
    await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })));
    homes.clear();
  });

  it("applies PATH from the user's login shell", async () => {
    const home = await createShellHome();
    homes.add(home);
    const binDir = path.join(home, "tools");
    await mkdir(binDir);
    await writeFile(path.join(home, ".zprofile"), 'export PATH="$HOME/tools:$PATH"\n');
    const env = createEnv(home);
    const logger = new RecordingLoginShellLogger();

    inheritLoginShellEnv({ env, logger });

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "[login-shell-env] start",
      "[login-shell-env] attempt applied",
      "[login-shell-env] applied",
    ]);
    expect(logger.warnings).toEqual([]);
    expect(logger.infos[1]?.fields).toMatchObject({
      attemptKind: "interactive",
      shellArgs: ["-i", "-l", "-c"],
      reason: "success",
    });
    expect(logger.infos[2]?.fields).toMatchObject({
      attemptKind: "interactive",
      beforePath: basePath,
      afterPath: env.PATH,
      pathChanged: true,
      shell: zsh,
    });
  });

  it("loads the user's zshrc while resolving the login shell env", async () => {
    const home = await createShellHome();
    homes.add(home);
    await writeFile(path.join(home, ".zshrc"), "export PASEO_TEST_ZSHRC_LOADED=1\n");
    const env = createEnv(home);
    const logger = new RecordingLoginShellLogger();

    inheritLoginShellEnv({ env, logger });

    expect(env.PASEO_TEST_ZSHRC_LOADED).toBe("1");
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "[login-shell-env] start",
      "[login-shell-env] attempt applied",
      "[login-shell-env] applied",
    ]);
    expect(logger.warnings).toEqual([]);
  });

  it("keeps the inherited env and logs stdout diagnostics when shell startup fails", async () => {
    const home = await createShellHome();
    homes.add(home);
    await writeFile(path.join(home, ".zshenv"), "print -r -- premarker\nexit 42\n");
    const env = createEnv(home);
    const logger = new RecordingLoginShellLogger();

    inheritLoginShellEnv({ env, logger });

    expect(env.PATH).toBe(basePath);
    expect(logger.infos.map((entry) => entry.message)).toEqual(["[login-shell-env] start"]);
    expect(logger.warnings.map((entry) => entry.message)).toEqual([
      "[login-shell-env] attempt failed; retrying",
      "[login-shell-env] attempt failed",
      "[login-shell-env] failed; keeping inherited env",
    ]);
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "non-zero-exit",
      attemptKind: "interactive",
      shell: zsh,
      shellArgs: ["-i", "-l", "-c"],
      status: 42,
      stdoutLength: "premarker\n".length,
      markerFound: false,
    });
    expect(logger.warnings[1]?.fields).toMatchObject({
      reason: "non-zero-exit",
      attemptKind: "non-interactive",
      shell: zsh,
      shellArgs: ["-l", "-c"],
      status: 42,
      stdoutLength: "premarker\n".length,
      markerFound: false,
    });
    expect(logger.warnings[2]?.fields).toMatchObject({
      reason: "non-zero-exit",
      attemptKind: "non-interactive",
      shell: zsh,
      shellArgs: ["-l", "-c"],
      status: 42,
      stdoutLength: "premarker\n".length,
      markerFound: false,
      beforePath: basePath,
      afterPath: basePath,
      pathChanged: false,
    });
    expectNoRawStdout(logger.warnings[2]?.fields ?? {});
  });

  it("keeps the inherited env when a timed-out shell printed an env marker", async () => {
    const home = await createShellHome();
    homes.add(home);
    const env = createEnv(home);
    const logger = new RecordingLoginShellLogger();
    const timedOutPath = path.join(home, "timed-out");
    let stdout = "";
    const timeoutError = Object.assign(new Error("spawnSync ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const spawnSync: LoginShellSpawnSync = (_shell, args) => {
      const shellCommand = String(Array.isArray(args) ? args.at(-1) : "");
      const marker = markerFromShellCommand(shellCommand);
      stdout = `${marker}${JSON.stringify({ ...env, PATH: timedOutPath })}${marker}`;

      return {
        pid: 0,
        output: [stdout, stdout, ""],
        stdout,
        stderr: "",
        status: null,
        signal: "SIGTERM",
        error: timeoutError,
      } satisfies SpawnSyncReturns<string>;
    };

    inheritLoginShellEnv({ env, logger, spawnSync });

    expect(env.PATH).toBe(basePath);
    expect(logger.infos.map((entry) => entry.message)).toEqual(["[login-shell-env] start"]);
    expect(logger.warnings.map((entry) => entry.message)).toEqual([
      "[login-shell-env] attempt failed; retrying",
      "[login-shell-env] attempt failed",
      "[login-shell-env] failed; keeping inherited env",
    ]);
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "timeout",
      attemptKind: "interactive",
      shell: zsh,
      shellArgs: ["-i", "-l", "-c"],
      status: null,
      signal: "SIGTERM",
      stdoutLength: stdout.length,
      markerFound: true,
      errorCode: "ETIMEDOUT",
    });
    expect(logger.warnings[1]?.fields).toMatchObject({
      reason: "timeout",
      attemptKind: "non-interactive",
      shell: zsh,
      shellArgs: ["-l", "-c"],
      status: null,
      signal: "SIGTERM",
      stdoutLength: stdout.length,
      markerFound: true,
      errorCode: "ETIMEDOUT",
    });
    expect(logger.warnings[2]?.fields).toMatchObject({
      reason: "timeout",
      attemptKind: "non-interactive",
      shell: zsh,
      shellArgs: ["-l", "-c"],
      status: null,
      signal: "SIGTERM",
      stdoutLength: stdout.length,
      markerFound: true,
      errorCode: "ETIMEDOUT",
      beforePath: basePath,
      afterPath: basePath,
      pathChanged: false,
    });
    expectNoRawStdout(logger.warnings[2]?.fields ?? {});
  });
});
