import type {
  AgentOptionControl,
  AgentOptionSelectControl,
  AgentOptionToggleControl,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";

/**
 * The composer's option controls. A control only describes how to draw one option key; the
 * value is read from `options`, which the daemon resolved (defaults, aliases, what runs).
 */
export interface ComposerOptionControls {
  controls: AgentOptionControl[];
  options: ProviderOptions;
  onSetOption: (key: string, value: unknown) => void;
}

export function readToggleOption(
  control: AgentOptionToggleControl,
  options: ProviderOptions,
): boolean {
  const value = options[control.key];
  return typeof value === "boolean" ? value : (control.defaultValue ?? false);
}

/** The selected choice's value, or the control's default when the option names no choice. */
export function readSelectOption(
  control: AgentOptionSelectControl,
  options: ProviderOptions,
): string | null {
  const value = options[control.key];
  if (typeof value === "string" && control.choices.some((choice) => choice.value === value)) {
    return value;
  }
  return control.defaultValue ?? null;
}

/** Whether the option is set to something other than the control's default. */
export function isControlActive(control: AgentOptionControl, options: ProviderOptions): boolean {
  if (control.type === "toggle") return readToggleOption(control, options);
  const value = readSelectOption(control, options);
  return value !== null && value !== control.defaultValue;
}

export function getControlTooltip(control: Pick<AgentOptionControl, "label" | "tooltip">): string {
  return control.tooltip ?? control.label;
}
