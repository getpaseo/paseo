import type { SettingsSeed } from "@/storage/settings-seed/types";

/**
 * Only the Electron desktop build has a seed file. iOS, Android and browser web have no
 * read-only layer, so every registered key behaves exactly as it did before.
 */
export async function loadSettingsSeed(): Promise<SettingsSeed | null> {
  return null;
}
