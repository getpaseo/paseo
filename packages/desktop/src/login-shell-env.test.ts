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
type LoginShellEnvInput = NonNullable<Parameters<typeof inheritLoginShellEnv>[0]>;
type LoginShellSpawnSync = NonNullable<LoginShellEnvInput["spawnSync"]>;

interface RecordedLog {
  message: string;
  fields: Record<string, unknown>;
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
      "[login-shell-env] applied",
    ]);
    expect(logger.warnings).toEqual([]);
    expect(logger.infos[1]?.fields).toMatchObject({
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
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe("[login-shell-env] failed; keeping inherited env");
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "non-zero-exit",
      shell: zsh,
      shellArgs: ["-i", "-l", "-c"],
      status: 42,
      stdoutLength: "premarker\n".length,
      markerFound: false,
      beforePath: basePath,
      afterPath: basePath,
      pathChanged: false,
    });
    expectNoRawStdout(logger.warnings[0]?.fields ?? {});
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
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe("[login-shell-env] failed; keeping inherited env");
    expect(logger.warnings[0]?.fields).toMatchObject({
      reason: "spawn-error",
      shell: zsh,
      shellArgs: ["-i", "-l", "-c"],
      status: null,
      signal: "SIGTERM",
      stdoutLength: stdout.length,
      markerFound: true,
      errorCode: "ETIMEDOUT",
      beforePath: basePath,
      afterPath: basePath,
      pathChanged: false,
    });
    expectNoRawStdout(logger.warnings[0]?.fields ?? {});
  });
});
