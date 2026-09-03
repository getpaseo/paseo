import {
  findLayerableSetting,
  type LayerableSetting,
  LAYERABLE_SETTINGS,
} from "@/storage/settings-seed/registry";
import type { SettingsKeyValueStorage } from "@/storage/settings-seed/layered-storage";

/** The `app` section of the desktop `settings.json`, keyed by seed field name. */
export type ClientSettingsFields = Record<string, unknown>;

export interface ClientSettingsBaseStorageDeps {
  /**
   * AsyncStorage. Keys outside the registry never reach the file, and the one-time migration
   * reads the registered keys' pre-existing values from here.
   */
  fallback: SettingsKeyValueStorage;
  /** `null` means the file does not exist yet. A corrupt file must reject, never resolve `null`. */
  getDocument: () => Promise<{ app: ClientSettingsFields } | null>;
  setField: (field: string, value: unknown) => Promise<void>;
  initialize: (entries: ClientSettingsFields) => Promise<{ app: ClientSettingsFields }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns a stored string into the value the file holds. `scalar` keeps the raw string; the object
 * kinds store real JSON so the file stays hand-editable and matches the seed's shape. A value the
 * app wrote that is not a JSON object is stored verbatim rather than dropped.
 */
function toFileValue(setting: LayerableSetting, stored: string): unknown {
  if (setting.kind === "scalar") {
    return stored;
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Falls through to the verbatim path below.
  }
  console.error(
    `[Settings] Storing "${setting.storageKey}" verbatim: the value is not a JSON object.`,
  );
  return stored;
}

/** `null` means the field cannot be read back, which reads as "unset" so lower layers show through. */
function toStoredValue(setting: LayerableSetting, value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (setting.kind !== "scalar" && isRecord(value)) {
    return JSON.stringify(value);
  }
  const expected = setting.kind === "scalar" ? "a string" : "an object";
  console.error(
    `[Settings] Ignoring "${setting.seedField}" in settings.json: expected ${expected}.`,
  );
  return null;
}

/**
 * A writable settings file as the base layer. Registered keys live in the file the main process
 * owns; everything else stays in AsyncStorage, unchanged.
 *
 * The document is fetched once per page load, like the seed, and kept current in memory as writes
 * go through. An external edit applies on the next reload.
 */
export function createClientSettingsBaseStorage(
  deps: ClientSettingsBaseStorageDeps,
): SettingsKeyValueStorage {
  let fields: Promise<ClientSettingsFields> | undefined;

  async function migrateFromFallback(): Promise<ClientSettingsFields> {
    const entries: ClientSettingsFields = {};
    for (const setting of LAYERABLE_SETTINGS) {
      const stored = await deps.fallback.getItem(setting.storageKey);
      if (stored === null) continue;
      entries[setting.seedField] = toFileValue(setting, stored);
    }
    // The legacy values stay in AsyncStorage, ignored from here on. Adopting whatever
    // `initialize` returns keeps a second window that won the race authoritative.
    const document = await deps.initialize(entries);
    return { ...document.app };
  }

  function loadFields(): Promise<ClientSettingsFields> {
    fields ??= (async () => {
      const document = await deps.getDocument();
      return document ? { ...document.app } : await migrateFromFallback();
    })();
    return fields;
  }

  return {
    async getItem(key: string): Promise<string | null> {
      const setting = findLayerableSetting(key);
      if (!setting) {
        return await deps.fallback.getItem(key);
      }
      const current = await loadFields();
      if (!Object.hasOwn(current, setting.seedField)) {
        return null;
      }
      return toStoredValue(setting, current[setting.seedField]);
    },

    async setItem(key: string, value: string): Promise<void> {
      const setting = findLayerableSetting(key);
      if (!setting) {
        await deps.fallback.setItem(key, value);
        return;
      }
      const current = await loadFields();
      const fileValue = toFileValue(setting, value);
      await deps.setField(setting.seedField, fileValue);
      current[setting.seedField] = fileValue;
    },

    async removeItem(key: string): Promise<void> {
      const setting = findLayerableSetting(key);
      if (!setting) {
        await deps.fallback.removeItem(key);
        return;
      }
      const current = await loadFields();
      await deps.setField(setting.seedField, null);
      delete current[setting.seedField];
    },
  };
}
