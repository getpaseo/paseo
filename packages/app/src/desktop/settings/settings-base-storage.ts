import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SettingsKeyValueStorage } from "@/storage/settings-seed/layered-storage";

/**
 * The writable layer under the settings seed. Only the Electron desktop build has a settings file
 * to write to; iOS, Android and browser web persist to AsyncStorage exactly as they always have.
 */
export const settingsBaseStorage: SettingsKeyValueStorage = AsyncStorage;
