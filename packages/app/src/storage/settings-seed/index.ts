import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadSettingsSeed } from "@/desktop/settings/settings-seed-source";
import { createLayeredSettingsStorage } from "./layered-storage";

/**
 * The storage every seedable preference store writes through: a read-only seed layer under the
 * machine-local AsyncStorage layer. Saves persist only what differs from the seed.
 */
export const layeredSettingsStorage = createLayeredSettingsStorage({
  base: AsyncStorage,
  loadSeed: loadSettingsSeed,
});

export { createLayeredSettingsStorage, SeedShadowedError } from "./layered-storage";
export type { LayeredSettingsStorageDeps, SettingsKeyValueStorage } from "./layered-storage";
export { findLayerableSetting, LAYERABLE_SETTINGS } from "./registry";
export type { LayerableSetting, SeedValueKind } from "./registry";
export { loadSettingsSeed } from "@/desktop/settings/settings-seed-source";
export type { SettingsSeed } from "./types";
