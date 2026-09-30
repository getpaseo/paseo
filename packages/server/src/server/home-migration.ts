import { lstat, readlink, realpath, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOME_DIRNAME, LEGACY_HOME_DIRNAME } from "./paseo-home.js";
import { isLocked } from "./pid-lock.js";

export type HomeMigrationAction =
  | "migrated"
  | "would_migrate"
  | "already_migrated"
  | "nothing_to_migrate";

export interface HomeMigrationResult {
  action: HomeMigrationAction;
  legacyHome: string;
  home: string;
  dryRun: boolean;
}

export class HomeMigrationError extends Error {
  constructor(
    public readonly code:
      | "DAEMON_RUNNING"
      | "BOTH_HOMES_EXIST"
      | "LEGACY_HOME_NOT_DIRECTORY"
      | "SYMLINK_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "HomeMigrationError";
  }
}

export interface MigrateLegacyHomeOptions {
  homeDir?: string;
  dryRun?: boolean;
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pointsAt(link: string, target: string): Promise<boolean> {
  try {
    return (await realpath(link)) === (await realpath(target));
  } catch {
    return false;
  }
}

/**
 * Moves ~/.paseo to ~/.pandaos and leaves ~/.paseo as a symlink, so absolute paths that
 * git worktree metadata, external scripts and running agents recorded keep resolving.
 */
export async function migrateLegacyHome(
  options: MigrateLegacyHomeOptions = {},
): Promise<HomeMigrationResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const dryRun = options.dryRun === true;
  const legacyHome = path.join(homeDir, LEGACY_HOME_DIRNAME);
  const home = path.join(homeDir, HOME_DIRNAME);
  const result = (action: HomeMigrationAction): HomeMigrationResult => ({
    action,
    legacyHome,
    home,
    dryRun,
  });

  const legacy = await lstatOrNull(legacyHome);
  if (!legacy) return result("nothing_to_migrate");
  if (legacy.isSymbolicLink()) {
    if (await pointsAt(legacyHome, home)) return result("already_migrated");
    throw new HomeMigrationError(
      "LEGACY_HOME_NOT_DIRECTORY",
      `${legacyHome} is a symlink to ${await readlink(legacyHome)}, not to ${home}. Resolve it by hand; nothing was changed.`,
    );
  }
  if (!legacy.isDirectory()) {
    throw new HomeMigrationError(
      "LEGACY_HOME_NOT_DIRECTORY",
      `${legacyHome} is not a directory. Nothing was changed.`,
    );
  }
  if (await lstatOrNull(home)) {
    throw new HomeMigrationError(
      "BOTH_HOMES_EXIST",
      `Both ${legacyHome} and ${home} exist. Merge or remove one of them by hand, then run the migration again. Nothing was changed.`,
    );
  }

  const lock = await isLocked(legacyHome);
  if (lock.locked) {
    throw new HomeMigrationError(
      "DAEMON_RUNNING",
      `A daemon is running from ${legacyHome} (PID ${lock.info?.pid}). Stop it first, then run the migration again. Nothing was changed.`,
    );
  }

  if (dryRun) return result("would_migrate");

  // Same parent directory, so rename is atomic and never copies.
  await rename(legacyHome, home);
  try {
    // Relative target keeps the link valid if the user's home directory moves; Windows needs a
    // junction (no admin rights), and junctions take absolute targets.
    if (process.platform === "win32") await symlink(home, legacyHome, "junction");
    else await symlink(HOME_DIRNAME, legacyHome, "dir");
  } catch (error) {
    await rename(home, legacyHome);
    throw new HomeMigrationError(
      "SYMLINK_FAILED",
      `Could not create the symlink ${legacyHome} -> ${home} (${String(error)}). The rename was rolled back.`,
    );
  }
  return result("migrated");
}
