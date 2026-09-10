import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { HubCommandError } from "./error.js";

const TRIGGER_DIRECTORY = ".paseo/triggers";

export interface HubDeployTrigger {
  path: string;
  yaml: string;
}

export async function discoverHubTriggers(cwd: string): Promise<HubDeployTrigger[]> {
  const root = path.resolve(cwd);
  const directory = path.join(root, TRIGGER_DIRECTORY);
  const paseoDirectory = await readStats(path.join(root, ".paseo"), {
    code: "HUB_TRIGGER_DIRECTORY_MISSING",
    message: `${TRIGGER_DIRECTORY} does not exist. Run this command from the project root.`,
  });
  if (paseoDirectory.isSymbolicLink()) throw unsafeTriggerPath(TRIGGER_DIRECTORY);
  const directoryStats = await readTriggerDirectoryStats(root, directory);
  if (directoryStats.isSymbolicLink()) throw unsafeTriggerPath(TRIGGER_DIRECTORY);
  if (!directoryStats.isDirectory()) {
    throw new HubCommandError(
      "HUB_TRIGGER_DIRECTORY_INVALID",
      `${TRIGGER_DIRECTORY} must be a directory.`,
    );
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!isExpectedReadError(error)) throw error;
    throw unreadableTriggerPath(TRIGGER_DIRECTORY);
  }
  const triggers: HubDeployTrigger[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const triggerPath = `${TRIGGER_DIRECTORY}/${entry.name}`;
    if (entry.isSymbolicLink()) throw unsafeTriggerPath(triggerPath);
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      throw new HubCommandError(
        "HUB_TRIGGER_PATH_UNSUPPORTED",
        `${triggerPath} must be a direct-child .yml trigger.`,
      );
    }
    try {
      triggers.push({
        path: triggerPath,
        yaml: await readFile(path.join(root, triggerPath), "utf8"),
      });
    } catch (error) {
      if (!isExpectedReadError(error)) throw error;
      throw unreadableTriggerPath(triggerPath);
    }
  }
  if (triggers.length === 0) {
    throw new HubCommandError(
      "HUB_TRIGGER_MISSING",
      `${TRIGGER_DIRECTORY} must contain at least one direct-child .yml trigger.`,
    );
  }
  return triggers;
}

async function readTriggerDirectoryStats(
  root: string,
  directory: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      if (!isExpectedReadError(error)) throw error;
      throw unreadableTriggerPath(TRIGGER_DIRECTORY);
    }
    if (await legacyBundleExists(root)) {
      throw new HubCommandError(
        "HUB_PROJECT_REQUIRED",
        "This directory contains a legacy .paseo/hub.yml bundle. Pass --project <slug> to deploy it.",
      );
    }
    throw new HubCommandError(
      "HUB_TRIGGER_DIRECTORY_MISSING",
      `${TRIGGER_DIRECTORY} does not exist. Run this command from the project root.`,
    );
  }
}

async function legacyBundleExists(root: string): Promise<boolean> {
  try {
    await lstat(path.join(root, ".paseo/hub.yml"));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (!isExpectedReadError(error)) throw error;
    throw unreadableTriggerPath(".paseo/hub.yml");
  }
}

async function readStats(
  target: string,
  missing: { code: string; message: string },
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new HubCommandError(missing.code, missing.message);
    if (!isExpectedReadError(error)) throw error;
    throw unreadableTriggerPath(TRIGGER_DIRECTORY);
  }
}

function unsafeTriggerPath(triggerPath: string): HubCommandError {
  return new HubCommandError("HUB_TRIGGER_UNSAFE_PATH", `${triggerPath} must not use a symlink.`);
}

function unreadableTriggerPath(triggerPath: string): HubCommandError {
  return new HubCommandError(
    "HUB_TRIGGER_UNREADABLE",
    `Could not read ${triggerPath}. Check the file and permissions.`,
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isExpectedReadError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "ELOOP" ||
    code === "EISDIR"
  );
}
