import {
  DEFAULT_CONTROL_SIZING_PREFERENCE,
  type ControlSizingPreference,
} from "./control-sizing-preference";

// Native settings storage is asynchronous, so a stylesheet cannot read it when it loads. Native
// builds run on touch screens and keep the automatic sizing; the setting is offered on web only.
export function readStoredControlSizingPreference(): ControlSizingPreference {
  return DEFAULT_CONTROL_SIZING_PREFERENCE;
}
