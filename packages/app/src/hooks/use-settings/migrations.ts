import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { APP_SETTINGS_KEY, SETTINGS_MIGRATIONS_KEY } from "./keys";
import type { AppSettings, KeyValueStorage } from "./storage";

const AppliedMigrationsSchema = z.strictObject({ applied: z.array(z.string()) });

/**
 * `sendBehavior` defaulted to "interrupt" for the months before steering existed, and defaults
 * are materialized into storage on first load, so a stored "interrupt" cannot be told apart from
 * a deliberate one. This flips every stored "interrupt" to "steer" exactly once; picking
 * "interrupt" afterwards sticks.
 */
const STEER_DEFAULT_MIGRATION = "steer-default";

/**
 * Brings stored settings up to date, returning what the caller should use. Owns both writes so
 * the marker can only ever be written after the settings it describes: a failed marker write
 * leaves the migration to re-run harmlessly, while a failed settings write must leave the marker
 * unwritten or the migration is lost for good.
 */
export async function migrateAppSettings(
  settings: AppSettings,
  storage: KeyValueStorage,
): Promise<AppSettings> {
  const stored = await readValidatedJson(storage, SETTINGS_MIGRATIONS_KEY, AppliedMigrationsSchema);
  const applied = new Set(stored?.applied ?? []);
  if (applied.has(STEER_DEFAULT_MIGRATION)) {
    return settings;
  }

  const migrated: AppSettings =
    settings.sendBehavior === "interrupt" ? { ...settings, sendBehavior: "steer" } : settings;
  if (migrated !== settings) {
    await storage.setItem(APP_SETTINGS_KEY, JSON.stringify(migrated));
  }

  applied.add(STEER_DEFAULT_MIGRATION);
  await storage.setItem(SETTINGS_MIGRATIONS_KEY, JSON.stringify({ applied: [...applied] }));
  return migrated;
}
