import { promises as fs } from "node:fs";
import { app } from "electron";
import log from "electron-log/main";
import { resolveCliInstallSourcePath } from "./path.js";
import { getBundledCliShimPath, getCliTargetPath, getLocalBinDir } from "./paths.js";
import { ensurePathInShellRc } from "./shell-rc.js";
import { renderWindowsCliShim } from "./windows-shim.js";

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

export async function installCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  const shimPath = getBundledCliShimPath();
  const installSourcePath = resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath,
    appImagePath: process.env.APPIMAGE,
  });
  const binDir = getLocalBinDir();

  await fs.mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    if (await pathOrSymlinkExists(targetPath)) {
      await fs.unlink(targetPath);
    }
    // Generate a thin .cmd trampoline that delegates to the bundled shim.
    // Only the app install path is baked in — internal details (asar layout,
    // entrypoint scripts) live in the bundled shim and update with the app.
    // cmd.exe reads the file in the OEM code page, so the content is kept
    // ASCII-only and the path goes through %LOCALAPPDATA% & co. (#4684).
    await fs.writeFile(targetPath, renderWindowsCliShim(shimPath), "ascii");
  } else {
    if (await pathOrSymlinkExists(targetPath)) {
      await fs.unlink(targetPath);
    }
    await fs.symlink(installSourcePath, targetPath);
  }

  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return { installed: await pathOrSymlinkExists(targetPath) };
}
