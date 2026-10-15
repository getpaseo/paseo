#!/usr/bin/env node

import { assertReleaseInventory } from "../../../scripts/local-release-inventory.mjs";
import { execFileSync } from "node:child_process";
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
  const source = path.join(desktopDir, ".dev", "release-local", "mac-arm64", "Paseo.app");
  const { verifyLocalRelease } = await import("./verify-local-release.mjs");
  await verifyLocalRelease(source, process.env.PASEO_LOCAL_RELEASE_COMMIT);
  const root = path.resolve(desktopDir, "../..");
  const commit = process.env.PASEO_LOCAL_RELEASE_COMMIT;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main");
  if (
    git("rev-parse", "HEAD") !== commit ||
    (!process.env.PASEO_LOCAL_INSTALL_TARGET && git("rev-parse", "origin/main") !== commit)
  )
    throw new Error("Install only the exact published commit through build:desktop:local");
  // Recheck after the long build and smoke tests: new work may have appeared meanwhile.
  assertReleaseInventory({ root, commit });
  const installedPath = await replaceAppBundle({
    source,
    target:
      process.env.PASEO_LOCAL_INSTALL_TARGET ??
      path.join(os.homedir(), "Applications", "Paseo Local.app"),
  });
  process.stdout.write(`Installed ${installedPath}\n`);
}
