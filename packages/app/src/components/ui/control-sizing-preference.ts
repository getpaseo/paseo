/**
 * The user's choice of control sizing on a wide layout. `auto` follows the device: touch-sized
 * when it has a touch screen. A laptop with a touch screen that is driven by a mouse picks
 * `pointer`. The compact layout is touch-sized whatever the choice.
 */
export const CONTROL_SIZING_PREFERENCES = ["auto", "touch", "pointer"] as const;
export type ControlSizingPreference = (typeof CONTROL_SIZING_PREFERENCES)[number];
export const DEFAULT_CONTROL_SIZING_PREFERENCE: ControlSizingPreference = "auto";

function isControlSizingPreference(value: unknown): value is ControlSizingPreference {
  return CONTROL_SIZING_PREFERENCES.some((preference) => preference === value);
}

/**
 * Reads the preference out of the raw app settings blob. Stylesheets size themselves when their
 * module loads, before the settings query resolves, so this reads the blob directly instead of
 * going through the settings schema.
 */
export function parseStoredControlSizingPreference(raw: string | null): ControlSizingPreference {
  if (raw === null) return DEFAULT_CONTROL_SIZING_PREFERENCE;
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return DEFAULT_CONTROL_SIZING_PREFERENCE;
    const preference: unknown = Reflect.get(stored, "controlSizing");
    return isControlSizingPreference(preference) ? preference : DEFAULT_CONTROL_SIZING_PREFERENCE;
  } catch {
    return DEFAULT_CONTROL_SIZING_PREFERENCE;
  }
}
