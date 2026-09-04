import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Read-only defaults layered underneath the locally persisted settings. The app
 * never writes this file, so it can be a symlink into a dotfiles repo (or a Nix
 * store path) that the user source-controls.
 */
export interface SettingsSeedDocument {
  path: string;
  /** Renderer-owned sections; opaque to the main process. */
  app: Record<string, unknown>;
  /** Desktop-owned section, coerced by the desktop settings store. */
  desktop: unknown;
}

export const SETTINGS_SEED_FILENAME = "settings-seed.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function getSettingsSeedPath(userDataPath: string): string {
  return path.resolve(userDataPath, SETTINGS_SEED_FILENAME);
}

/**
 * Reads the seed file fresh on every call so edits to a symlinked dotfiles copy
 * apply on the next settings read instead of requiring an app restart.
 */
export async function loadSettingsSeed({
  userDataPath,
}: {
  userDataPath: string;
}): Promise<SettingsSeedDocument | null> {
  const filePath = getSettingsSeedPath(userDataPath);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    // A dangling symlink reports ENOENT too, which is the same "no seed" state.
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[SettingsSeed] Failed to read ${filePath}: ${message}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[SettingsSeed] Invalid JSON in ${filePath}: ${message}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`[SettingsSeed] Expected a JSON object at the root of ${filePath}`);
  }

  return {
    path: filePath,
    app: isRecord(parsed.app) ? parsed.app : {},
    desktop: parsed.desktop,
  };
}
