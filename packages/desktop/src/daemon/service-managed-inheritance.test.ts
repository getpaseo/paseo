import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

import { createElectronNodeEnv, createNodeEntrypointInvocation } from "./node-entrypoint-launcher";
import { inheritLoginShellEnv } from "../login-shell-env";
import {
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

/**
 * `PASEO_SERVICE_MANAGED` means a service manager owns the daemon, which makes
 * the daemon refuse a client shutdown. A daemon the desktop starts must never
 * carry that claim, or the desktop quits and leaves its own daemon running.
 */
const DAEMON_ENTRYPOINT = {
  entryPath: "/tmp/paseo-daemon-runner.js",
  execArgv: ["--import", "tsx"],
};

function markerFromShellCommand(shellCommand: string): string {
  const match = /"([0-9a-f]{12})" \+ JSON\.stringify\(process\.env\) \+ "\1"/.exec(shellCommand);
  if (!match?.[1]) throw new Error(`missing env marker in shell command: ${shellCommand}`);
  return match[1];
}

function shellSuccess(shellCommand: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const marker = markerFromShellCommand(shellCommand);
  const stdout = `${marker}${JSON.stringify(env)}${marker}`;
  return {
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
  };
}

class SilentLoginShellLogger {
  info(_message: string, _fields: Record<string, unknown>): void {}
  warn(_message: string, _fields: Record<string, unknown>): void {}
}

const silentLogger = new SilentLoginShellLogger();

describe("desktop daemon service-managed inheritance", () => {
  it("drops an inherited service-managed claim while keeping desktop ownership", () => {
    const invocation = createNodeEntrypointInvocation({
      execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      isPackaged: false,
      packagedRunnerPath: null,
      entrypoint: DAEMON_ENTRYPOINT,
      argvMode: "node-script",
      args: [],
      // The desktop was launched from a shell that already had the claim set.
      baseEnv: { PATH: "/usr/bin", PASEO_SERVICE_MANAGED: "1", PASEO_DESKTOP_MANAGED: "1" },
    });

    expect(invocation.env).not.toHaveProperty("PASEO_SERVICE_MANAGED");
    expect(invocation.env.PASEO_DESKTOP_MANAGED).toBe("1");
  });

  it("drops the claim on the packaged launch path too", () => {
    const invocation = createNodeEntrypointInvocation({
      execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      isPackaged: true,
      packagedRunnerPath: "/Applications/Paseo.app/Contents/Resources/runner.js",
      entrypoint: DAEMON_ENTRYPOINT,
      argvMode: "node-script",
      args: [],
      baseEnv: { PATH: "/usr/bin", PASEO_SERVICE_MANAGED: "1" },
    });

    expect(invocation.env).not.toHaveProperty("PASEO_SERVICE_MANAGED");
  });

  it("removes the key rather than leaving it for an overlay to mask", () => {
    // A spread overlay only adds and overwrites, so it can never clear an
    // inherited key. The env itself has to drop it.
    expect(createElectronNodeEnv({ PASEO_SERVICE_MANAGED: "1" })).not.toHaveProperty(
      "PASEO_SERVICE_MANAGED",
    );
  });

  it("drops a claim a login profile exports back through shell resolution", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

    inheritLoginShellEnv({
      env,
      logger: silentLogger,
      platform: "darwin",
      spawnSync: (_shell, args) => {
        const argv = Array.isArray(args) ? args.map(String) : [];
        // The user's .zshrc exports it, so it comes back in the parsed output.
        return shellSuccess(String(argv.at(-1)), {
          PATH: "/opt/homebrew/bin:/usr/bin",
          PASEO_SERVICE_MANAGED: "1",
        });
      },
    });

    expect(env).not.toHaveProperty("PASEO_SERVICE_MANAGED");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("drops an inherited claim when shell resolution fails", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      PASEO_SERVICE_MANAGED: "1",
    };

    inheritLoginShellEnv({
      env,
      logger: silentLogger,
      platform: "darwin",
      spawnSync: () => {
        throw new Error("shell unavailable");
      },
    });

    // The failure path keeps the inherited env; it must not keep this key.
    expect(env).not.toHaveProperty("PASEO_SERVICE_MANAGED");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("quits and stops the daemon it owns", async () => {
    let stopped = false;
    const stoppedOnQuit = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => ({ daemon: { keepRunningAfterQuit: false } }) },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async () => {
        stopped = true;
      },
      showShutdownFeedback: () => {},
    });

    expect(shouldStopDesktopManagedDaemonOnQuit({ daemon: { keepRunningAfterQuit: false } })).toBe(
      true,
    );
    expect(stoppedOnQuit).toBe(true);
    expect(stopped).toBe(true);
  });
});
