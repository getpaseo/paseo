/** Storage keys live here so `storage` and `migrations` can share them without importing each other. */

export const APP_SETTINGS_KEY = "@paseo:app-settings";
export const LEGACY_SETTINGS_KEY = "@paseo:settings";

/**
 * The applied-migration marker deliberately sits outside the settings blob:
 * `StoredAppSettingsSchema` is a strict object and `readValidatedJson` clears the value when
 * parsing fails, so a new field there would wipe every setting for anyone who downgrades to a
 * client that predates it. Keeping the marker as a list of ids also means the next migration is
 * a new entry rather than a schema change.
 */
export const SETTINGS_MIGRATIONS_KEY = "@paseo:settings-migrations";
