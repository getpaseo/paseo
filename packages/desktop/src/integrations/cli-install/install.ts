import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { resolveCliInstallSourcePath } from "./path.js";
import { getBundledCliShimPath, getCliTargetPath, getLocalBinDir } from "./paths.js";
import { ensurePathInShellRc } from "./shell-rc.js";
import {
  WINDOWS_CLI_FORWARD_TARGET,
  canReplaceWindowsCliExecutable,
  isLegacyWindowsCliTrampoline,
  isWindowsCliForwardTarget,
  legacyWindowsCmdTrampoline,
  windowsCliForwardTargetContents,
} from "./windows-cli-install.js";

interface InstallStatus {
  installed: boolean;
}

async function pathOrSymlinkExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function resolveInstallSourcePath(shimPath: string): string {
  return resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath,
    appImagePath: process.env.APPIMAGE,
  });
}

function windowsForwardTargetPath(exePath: string): string {
  return path.join(path.dirname(exePath), WINDOWS_CLI_FORWARD_TARGET);
}

function legacyWindowsCmdPath(exePath: string): string {
  return path.join(path.dirname(exePath), "paseo.cmd");
}

export async function installCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  const shimPath = getBundledCliShimPath();

  await fs.mkdir(getLocalBinDir(), { recursive: true });
  const targetExists = await pathOrSymlinkExists(targetPath);
  if (process.platform === "win32" && app.isPackaged) {
    const ownInstall = targetExists && (await isOwnInstall(targetPath));
    if (!canReplaceWindowsCliExecutable(targetExists, ownInstall)) {
      log.warn("[integrations] Left a paseo CLI this app did not install", { targetPath });
      throw new Error(`A paseo command this app did not install is already at ${targetPath}`);
    }
  }
  if (targetExists) {
    await fs.unlink(targetPath);
  }
  if (process.platform === "win32" && app.isPackaged) {
    // PowerShell's Windows argument mode rewrites .cmd arguments before the batch file
    // starts, so the PATH entry has to be the console exe that forwards the raw command line.
    await fs.copyFile(shimPath, targetPath);
    await fs.writeFile(
      windowsForwardTargetPath(targetPath),
      windowsCliForwardTargetContents(shimPath),
      "utf8",
    );
    await removeLegacyWindowsCmd(shimPath);
  } else if (process.platform === "win32") {
    await fs.writeFile(targetPath, legacyWindowsCmdTrampoline(shimPath), "utf-8");
  } else {
    await fs.symlink(resolveInstallSourcePath(shimPath), targetPath);
  }

  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

/**
 * Removes the CLI only when the file at the target is the one this app installs, so a `paseo` the
 * user put there some other way survives. The shell rc PATH line stays: it is harmless and other
 * tools in ~/.local/bin rely on it.
 */
export async function uninstallCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  if (await isOwnInstall(targetPath)) {
    await fs.unlink(targetPath);
    if (process.platform === "win32" && app.isPackaged) {
      await fs.unlink(windowsForwardTargetPath(targetPath));
      await removeLegacyWindowsCmd(getBundledCliShimPath());
    }
  } else if (await pathOrSymlinkExists(targetPath)) {
    log.warn("[integrations] Left a paseo CLI this app did not install", { targetPath });
  }
  return getCliInstallStatus();
}

async function removeLegacyWindowsCmd(shimPath: string): Promise<void> {
  const legacyPath = legacyWindowsCmdPath(getCliTargetPath());
  if (!(await pathOrSymlinkExists(legacyPath))) return;
  const contents = await fs.readFile(legacyPath, "utf8");
  if (isLegacyWindowsCliTrampoline(contents, shimPath)) {
    await fs.unlink(legacyPath);
  }
}

async function isOwnInstall(targetPath: string): Promise<boolean> {
  const shimPath = getBundledCliShimPath();
  try {
    if (process.platform === "win32" && app.isPackaged) {
      const contents = await fs.readFile(windowsForwardTargetPath(targetPath), "utf8");
      return isWindowsCliForwardTarget(contents, shimPath);
    }
    if (process.platform === "win32") {
      return (await fs.readFile(targetPath, "utf-8")) === legacyWindowsCmdTrampoline(shimPath);
    }
    return (await fs.readlink(targetPath)) === resolveInstallSourcePath(shimPath);
  } catch {
    return false;
  }
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return { installed: await pathOrSymlinkExists(targetPath) };
}
