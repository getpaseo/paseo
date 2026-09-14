#!/usr/bin/env node

import { access, cp, mkdir, rename as fsRename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function replaceAppBundle({ source, target, rename = fsRename }) {
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`Local app bundle is not a directory: ${source}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = `${target}.installing-${suffix}`;
  const backup = `${target}.backup-${suffix}`;
  const hadTarget = await exists(target);

  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, verbatimSymlinks: true });

  try {
    if (hadTarget) await rename(target, backup);
    try {
      await rename(staging, target);
    } catch (error) {
      if (hadTarget) await rename(backup, target);
      throw error;
    }
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return target;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Paseo Local can only be installed by this command on macOS arm64");
  }

  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const installedPath = await replaceAppBundle({
    source: path.join(desktopDir, ".dev", "release-local", "mac-arm64", "Paseo.app"),
    target: path.join(os.homedir(), "Applications", "Paseo Local.app"),
  });
  process.stdout.write(`Installed ${installedPath}\n`);
}
