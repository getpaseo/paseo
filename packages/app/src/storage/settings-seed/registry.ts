/**
 * The opt-in boundary for seeded preferences. A storage key that is not listed here is never
 * merged, diffed, or blocked — it passes through the layered storage untouched.
 */

/**
 * - `struct`: fixed field set; the owning store normalizes its own fields and always writes a
 *   full object, so unknown seed fields are harmless and a missing field is never an error.
 * - `record`: open-ended keys the app treats as opaque (arbitrary ids added by other features).
 * - `scalar`: the raw stored string, not JSON.
 */
export type SeedValueKind = "struct" | "record" | "scalar";

export interface LayerableSetting {
  seedField: string;
  storageKey: string;
  kind: SeedValueKind;
}

export const LAYERABLE_SETTINGS: readonly LayerableSetting[] = [
  { seedField: "appSettings", storageKey: "@paseo:app-settings", kind: "struct" },
  {
    seedField: "keyboardShortcutOverrides",
    storageKey: "@paseo:keyboard-shortcut-overrides",
    kind: "record",
  },
  { seedField: "preferredEditor", storageKey: "@paseo:preferred-editor", kind: "scalar" },
  { seedField: "changesPreferences", storageKey: "@paseo:changes-preferences", kind: "struct" },
  {
    seedField: "createAgentPreferences",
    storageKey: "@paseo:create-agent-preferences",
    kind: "struct",
  },
];

export function findLayerableSetting(storageKey: string): LayerableSetting | undefined {
  return LAYERABLE_SETTINGS.find((setting) => setting.storageKey === storageKey);
}
