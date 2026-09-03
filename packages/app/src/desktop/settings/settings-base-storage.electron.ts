import AsyncStorage from "@react-native-async-storage/async-storage";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { SettingsKeyValueStorage } from "@/storage/settings-seed/layered-storage";
import {
  type ClientSettingsFields,
  createClientSettingsBaseStorage,
} from "./client-settings-store";

function parseDocument(result: unknown, required: true): { app: ClientSettingsFields };
function parseDocument(result: unknown, required: false): { app: ClientSettingsFields } | null;
function parseDocument(result: unknown, required: boolean): { app: ClientSettingsFields } | null {
  if (!required && (result === null || result === undefined)) {
    return null;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`[Settings] settings.json returned a non-object document: ${String(result)}`);
  }
  const { app } = result as { app?: unknown };
  if (typeof app !== "object" || app === null || Array.isArray(app)) {
    throw new Error('[Settings] settings.json returned a document without an "app" section.');
  }
  return { app: app as ClientSettingsFields };
}

/**
 * On desktop the writable layer is `settings.json` in the Electron userData directory, so the
 * values are a file a user can read, edit and check into dotfiles — not opaque LevelDB records
 * behind `localStorage`. Errors propagate: an unreadable settings file must fail loudly rather
 * than silently diverging onto the localStorage values it replaced.
 */
export const settingsBaseStorage: SettingsKeyValueStorage = createClientSettingsBaseStorage({
  fallback: AsyncStorage,
  getDocument: async () => parseDocument(await invokeDesktopCommand("get_client_settings"), false),
  setField: async (field, value) => {
    await invokeDesktopCommand("set_client_setting", { field, value });
  },
  initialize: async (entries) =>
    parseDocument(await invokeDesktopCommand("initialize_client_settings", { entries }), true),
});
