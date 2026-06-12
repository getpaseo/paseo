// Shell environment resolution adapted from VS Code
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename } from "node:path";
import log from "electron-log/main";

/**
 * Default timeout for the login-shell environment probe.
 *
 * The probe spawns an interactive login shell, which sources the user's full
 * shell init (e.g. oh-my-zsh, eager nvm, compinit). On a cold start that can
 * take well over 10s, so the previous fixed 10s budget was routinely exceeded,
 * silently falling back to the minimal launchd environment and making CLIs that
 * live only on the shell PATH (e.g. nvm-installed Claude/Codex) look like they
 * are "not installed".
 */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Timeout (ms) for the login-shell environment probe. Override with the
 * `PASEO_SHELL_ENV_TIMEOUT_MS` environment variable; invalid or non-positive
 * values fall back to {@link DEFAULT_RESOLVE_TIMEOUT_MS}.
 */
export function getResolveTimeoutMs(): number {
  const raw = process.env.PASEO_SHELL_ENV_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESOLVE_TIMEOUT_MS;
}

function getSystemShell(): string {
  const shell = process.env.SHELL;
  if (shell) return shell;

  try {
    const info = userInfo();
    if (info.shell && info.shell !== "/bin/false") return info.shell;
  } catch {}

  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function resolveShellEnv(): Record<string, string> | undefined {
  if (process.platform === "win32") return undefined;

  const savedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const savedNoAttach = process.env.ELECTRON_NO_ATTACH_CONSOLE;

  const mark = randomUUID().replace(/-/g, "").slice(0, 12);
  const regex = new RegExp(mark + "({.*})" + mark);

  const shell = getSystemShell();
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

  const shellEnv = { ...process.env };
  delete shellEnv.PASEO_NODE_ENV;
  delete shellEnv.PASEO_DESKTOP_MANAGED;
  delete shellEnv.PASEO_SUPERVISED;

  const timeoutMs = getResolveTimeoutMs();
  const result = spawnSync(shell, [...shellArgs, command], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...shellEnv,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    },
  });

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms (set PASEO_SHELL_ENV_TIMEOUT_MS to raise it)`
      : result.error.message;
    log.warn(`[login-shell-env] could not resolve ${shell} environment: ${detail}`);
    return undefined;
  }
  if (result.status !== 0 && result.status !== null) {
    log.warn(`[login-shell-env] ${shell} exited with status ${result.status}`);
    return undefined;
  }
  if (!result.stdout) {
    log.warn(`[login-shell-env] ${shell} produced no output`);
    return undefined;
  }

  const match = regex.exec(result.stdout);
  if (!match?.[1]) {
    log.warn(`[login-shell-env] could not parse environment marker from ${shell} output`);
    return undefined;
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
    log.warn(`[login-shell-env] failed to parse ${shell} environment output: ${String(error)}`);
    return undefined;
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
export function inheritLoginShellEnv(): void {
  try {
    const env = resolveShellEnv();
    if (env) {
      Object.assign(process.env, env);
      log.info(`[login-shell-env] inherited ${Object.keys(env).length} vars from login shell`);
    } else {
      log.warn("[login-shell-env] login shell env unresolved; nvm CLIs may appear unavailable");
    }
  } catch (error) {
    log.warn(`[login-shell-env] unexpected error resolving login shell env: ${String(error)}`);
  }
}
