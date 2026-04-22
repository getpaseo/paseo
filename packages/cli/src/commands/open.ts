import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

function findDesktopApp(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const candidates = ["/Applications/Paseo.app", path.join(homedir(), "Applications", "Paseo.app")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function cleanEnvForDesktopLaunch(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The CLI runs via ELECTRON_RUN_AS_NODE=1. Strip it before spawning Electron.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function spawnDetached(command: string, args: string[]): void {
  spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: cleanEnvForDesktopLaunch(),
  }).unref();
}

export async function openDesktopWithProject(projectPath: string): Promise<void> {
  try {
    if (process.env.PASEO_DESKTOP_CLI === "1") {
      throw new Error(
        "Cannot open a desktop project while running in desktop CLI passthrough mode.",
      );
    }

    if (process.platform !== "darwin") {
      throw new Error(
        "Paseo desktop is supported only on macOS. Use the web app on this platform.",
      );
    }

    const desktopApp = findDesktopApp();
    if (!desktopApp) {
      throw new Error(
        "Paseo desktop app not found. Install it from https://github.com/getpaseo/paseo/releases",
      );
    }

    // -n forces a new instance even if the app is already running.
    // The new instance hits requestSingleInstanceLock(), fails, and relays
    // the argv to the first instance via the second-instance event.
    // -g keeps the terminal in the foreground (better CLI UX).
    // Without -n, macOS just activates the existing window and drops --args.
    spawnDetached("open", ["-n", "-g", "-a", desktopApp, "--args", projectPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
