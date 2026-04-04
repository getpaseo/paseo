import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const DESKTOP_GUI_FLAG = "--open-project";

export function isPathLikeArg(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg === "~" ||
    arg.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(arg)
  );
}

function expandUserPath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveProjectDirectory(inputPath: string): string {
  const absolutePath = path.resolve(expandUserPath(inputPath));

  if (!existsSync(absolutePath)) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  const stat = statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absolutePath}`);
  }

  return absolutePath;
}

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

function spawnDetached(command: string, args: string[]): void {
  spawn(command, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export async function openDesktopWithProject(pathArg: string): Promise<void> {
  try {
    const projectPath = resolveProjectDirectory(pathArg);

    if (process.env.PASEO_DESKTOP_CLI === "1") {
      throw new Error(
        "Cannot open a desktop project while running in desktop CLI passthrough mode.",
      );
    }

    const desktopApp = findDesktopApp();
    if (!desktopApp) {
      throw new Error(
        "Paseo desktop app not found. Install it from https://github.com/getpaseo/paseo/releases",
      );
    }

    if (process.platform === "darwin") {
      spawnDetached("open", ["-a", desktopApp, "--args", DESKTOP_GUI_FLAG, projectPath]);
      return;
    }

    spawnDetached(desktopApp, [DESKTOP_GUI_FLAG, projectPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
