import { APP_SETTINGS_KEY } from "@/hooks/use-settings/keys";
import {
  DEFAULT_CONTROL_SIZING_PREFERENCE,
  parseStoredControlSizingPreference,
  type ControlSizingPreference,
} from "./control-sizing-preference";

// AsyncStorage on web is backed by localStorage, so the app settings blob can be read
// synchronously while stylesheets load.
export function readStoredControlSizingPreference(): ControlSizingPreference {
  try {
    return parseStoredControlSizingPreference(window.localStorage.getItem(APP_SETTINGS_KEY));
  } catch {
    return DEFAULT_CONTROL_SIZING_PREFERENCE;
  }
}
