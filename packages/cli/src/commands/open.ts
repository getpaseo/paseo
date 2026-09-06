import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnProcess } from "@getpaseo/server";
import { buildAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

function findDesktopApp(): string | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Paseo.app",
      path.join(homedir(), "Applications", "Paseo.app"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (process.platform === "linux") {
    const candidates = [
      "/usr/bin/Paseo",
      "/opt/Paseo/Paseo",
      path.join(homedir(), "Applications", "Paseo.AppImage"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      return null;
    }

    const candidate = path.join(localAppData, "Programs", "Paseo", "Paseo.exe");
    return existsSync(candidate) ? candidate : null;
  }

  return null;
}

function cleanEnvForDesktopLaunch(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The CLI runs via ELECTRON_RUN_AS_NODE=1. On Linux/Windows the spawned
  // desktop process inherits the env directly, so we must strip it or the
  // desktop app would start as a bare Node process instead of Electron.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.PASEO_NODE_ENV;
  return env;
}

export function resolveDesktopLaunch(input: {
  platform: NodeJS.Platform;
  desktopApp: string;
  args: string[];
}): { command: string; args: string[] } {
  if (input.platform === "darwin") {
    // A new instance relays argv through Electron's single-instance lock.
    return { command: "open", args: ["-n", "-g", "-a", input.desktopApp, "--args", ...input.args] };
  }

  const isLinuxAppImage = input.platform === "linux" && input.desktopApp.endsWith(".AppImage");
  // Match the AppImage desktop launcher. Electron can fail on its unprivileged
  // chrome-sandbox helper before main.ts gets to append this switch.
  const args = isLinuxAppImage ? ["--no-sandbox", ...input.args] : input.args;
  return { command: input.desktopApp, args };
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    env: cleanEnvForDesktopLaunch(),
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function launchDesktop(args: string[]): Promise<void> {
  if (process.env.PASEO_DESKTOP_CLI === "1") {
    throw new Error("Cannot open Paseo Desktop while running in desktop CLI passthrough mode.");
  }

  const desktopApp = findDesktopApp();
  if (!desktopApp) {
    throw new Error(
      "Paseo desktop app not found. Install it from https://github.com/getpaseo/paseo/releases",
    );
  }

  const launch = resolveDesktopLaunch({ platform: process.platform, desktopApp, args });
  await spawnDetached(launch.command, launch.args);
}

export async function openDesktopWithProject(projectPath: string): Promise<void> {
  try {
    await launchDesktop([projectPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktopWithAgent(target: AgentDeepLinkTarget): Promise<void> {
  await launchDesktop([buildAgentDeepLink(target)]);
}
