import path from "node:path";
import { createRequire } from "node:module";
import { cliTargetFileName, resolveCliShimPath } from "./path.js";
import os from "node:os";
import { app } from "electron";

export function getLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

export function getCliTargetPath(): string {
  return path.join(getLocalBinDir(), cliTargetFileName(process.platform, app.isPackaged));
}

export function getBundledCliShimPath(): string {
  return resolveCliShimPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    resolveWorkspaceCli: () => createRequire(__filename).resolve("@getpaseo/cli/bin/paseo"),
  });
}
