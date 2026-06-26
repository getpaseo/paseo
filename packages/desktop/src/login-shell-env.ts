// Shell environment resolution adapted from VS Code
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts
// Licensed under the MIT License.

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo as defaultUserInfo } from "node:os";
import { basename } from "node:path";
import defaultLog from "electron-log/main";

const RESOLVE_TIMEOUT_MS = 10_000;
const STDERR_LOG_LIMIT = 2000;

type LoginShellEnvLogger = Pick<typeof defaultLog, "info" | "warn">;

interface LoginShellEnvDependencies {
  env?: NodeJS.ProcessEnv;
  logger?: LoginShellEnvLogger;
  platform?: NodeJS.Platform;
  spawnSync?: typeof defaultSpawnSync;
  userInfo?: typeof defaultUserInfo;
}

function truncateForLog(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > STDERR_LOG_LIMIT
    ? `${trimmed.slice(0, STDERR_LOG_LIMIT)}...(truncated)`
    : trimmed;
}

function pathEnv(env: NodeJS.ProcessEnv | Record<string, string>): string | null {
  return env.PATH ?? env.Path ?? null;
}

interface ShellEnvErrorDetails {
  reason: string;
  shell?: string;
  shellArgs?: string[];
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutLength?: number;
  markerFound?: boolean;
  stderr?: string;
}

class ShellEnvError extends Error {
  constructor(
    message: string,
    readonly details: ShellEnvErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ShellEnvError";
  }
}

function throwIfShellFailed(
  result: SpawnSyncReturns<string>,
  regex: RegExp,
  shell: string,
  shellArgs: string[],
): void {
  if (result.error || result.signal) {
    throw new ShellEnvError(
      "login shell did not complete",
      {
        reason: result.error ? "spawn-error" : "signal",
        shell,
        shellArgs,
        status: result.status,
        signal: result.signal,
        stdoutLength: result.stdout?.length ?? 0,
        markerFound: regex.test(result.stdout ?? ""),
        stderr: result.stderr,
      },
      { cause: result.error },
    );
  }
  if (result.status !== 0 && result.status !== null) {
    throw new ShellEnvError("login shell exited non-zero", {
      reason: "non-zero-exit",
      shell,
      shellArgs,
      status: result.status,
      signal: result.signal,
      stdoutLength: result.stdout?.length ?? 0,
      markerFound: regex.test(result.stdout ?? ""),
      stderr: result.stderr,
    });
  }
  if (!result.stdout) {
    throw new ShellEnvError(
      "login shell produced no stdout",
      {
        reason: "no-stdout",
        shell,
        shellArgs,
        status: result.status,
        signal: result.signal,
        stdoutLength: result.stdout?.length ?? 0,
        markerFound: false,
        stderr: result.stderr,
      },
      { cause: result.error },
    );
  }
}

function getSystemShell(
  deps: Required<Pick<LoginShellEnvDependencies, "env" | "platform" | "userInfo">>,
): string {
  const shell = deps.env.SHELL;
  if (shell) return shell;

  try {
    const info = deps.userInfo();
    if (info.shell && info.shell !== "/bin/false") return info.shell;
  } catch {}

  return deps.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function resolveShellEnv(deps: Required<LoginShellEnvDependencies>): Record<string, string> {
  if (deps.platform === "win32") {
    throw new ShellEnvError("login shell env is not resolved on Windows", { reason: "win32" });
  }

  const savedRunAsNode = deps.env.ELECTRON_RUN_AS_NODE;
  const savedNoAttach = deps.env.ELECTRON_NO_ATTACH_CONSOLE;

  const mark = randomUUID().replace(/-/g, "").slice(0, 12);
  const regex = new RegExp(mark + "({.*})" + mark);

  const shell = getSystemShell(deps);
  const name = basename(shell);

  let command: string;
  let shellArgs: string[];

  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(name)) {
    command = `& '${process.execPath}' -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`;
    shellArgs = ["-Login", "-Command"];
  } else if (name === "nu") {
    command = `^'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
    shellArgs = ["-i", "-l", "-c"];
  } else if (name === "xonsh") {
    command = `import os, json; print("${mark}", json.dumps(dict(os.environ)), "${mark}")`;
    shellArgs = ["-i", "-l", "-c"];
  } else {
    command = `'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
    if (name === "tcsh" || name === "csh") {
      shellArgs = ["-ic"];
    } else {
      shellArgs = ["-i", "-l", "-c"];
    }
  }

  const shellEnv = { ...deps.env };
  delete shellEnv.PASEO_NODE_ENV;
  delete shellEnv.PASEO_DESKTOP_MANAGED;
  delete shellEnv.PASEO_SUPERVISED;

  deps.logger.info("[login-shell-env] start", {
    shell,
    shellArgs,
    timeoutMs: RESOLVE_TIMEOUT_MS,
    beforePath: pathEnv(deps.env),
  });

  const result = deps.spawnSync(shell, [...shellArgs, command], {
    encoding: "utf8",
    timeout: RESOLVE_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...shellEnv,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    },
  });

  throwIfShellFailed(result, regex, shell, shellArgs);

  const match = regex.exec(result.stdout);
  if (!match?.[1]) {
    throw new ShellEnvError("login shell output did not contain environment marker", {
      reason: "marker-missing",
      shell,
      shellArgs,
      status: result.status,
      signal: result.signal,
      stdoutLength: result.stdout.length,
      markerFound: false,
      stderr: result.stderr,
    });
  }

  try {
    const env = JSON.parse(match[1]) as Record<string, string>;

    if (savedRunAsNode) {
      env.ELECTRON_RUN_AS_NODE = savedRunAsNode;
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }

    if (savedNoAttach) {
      env.ELECTRON_NO_ATTACH_CONSOLE = savedNoAttach;
    } else {
      delete env.ELECTRON_NO_ATTACH_CONSOLE;
    }

    delete env.XDG_RUNTIME_DIR;

    return env;
  } catch (error) {
    throw new ShellEnvError(
      "failed to parse login shell environment JSON",
      {
        reason: "json-parse",
        shell,
        shellArgs,
        status: result.status,
        signal: result.signal,
        stdoutLength: result.stdout.length,
        markerFound: true,
        stderr: result.stderr,
      },
      { cause: error },
    );
  }
}

/**
 * On macOS/Linux, Electron inherits a minimal environment when launched from
 * Finder/Dock. Spawn the user's login shell and capture its full environment
 * via Node's JSON.stringify(process.env), so the daemon and all child processes
 * see the same tools and variables as a normal terminal session.
 *
 * Approach borrowed from VS Code (src/vs/platform/shell/node/shellEnv.ts).
 */
export function inheritLoginShellEnv(input: LoginShellEnvDependencies = {}): void {
  const deps: Required<LoginShellEnvDependencies> = {
    env: input.env ?? process.env,
    logger: input.logger ?? defaultLog,
    platform: input.platform ?? process.platform,
    spawnSync: input.spawnSync ?? defaultSpawnSync,
    userInfo: input.userInfo ?? defaultUserInfo,
  };
  const beforePath = pathEnv(deps.env);
  const startedAt = Date.now();

  try {
    const env = resolveShellEnv(deps);
    Object.assign(deps.env, env);
    deps.logger.info("[login-shell-env] applied", {
      durationMs: Date.now() - startedAt,
      beforePath,
      afterPath: pathEnv(deps.env),
      pathChanged: beforePath !== pathEnv(deps.env),
      shell: deps.env.SHELL ?? null,
    });
  } catch (error) {
    const details: ShellEnvErrorDetails =
      error instanceof ShellEnvError
        ? error.details
        : { reason: "throw", shell: deps.env.SHELL ?? undefined };
    const cause = error instanceof Error ? error.cause : undefined;
    deps.logger.warn("[login-shell-env] failed; keeping inherited env", {
      ...details,
      durationMs: Date.now() - startedAt,
      timeoutMs: RESOLVE_TIMEOUT_MS,
      error: error instanceof Error ? error.message : String(error),
      errorCode: (cause as NodeJS.ErrnoException | undefined)?.code ?? null,
      stderr: truncateForLog(details.stderr),
      beforePath,
      afterPath: pathEnv(deps.env),
      pathChanged: beforePath !== pathEnv(deps.env),
    });
    // Keep inherited environment if shell lookup fails.
  }
}
