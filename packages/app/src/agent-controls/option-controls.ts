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

/**
 * The next options record with one option set. The composer applies this optimistically
 * when a control is pressed: the rendered value reads the agent's `options`, and the
 * daemon's delta for the apply is not guaranteed to reach this composer's subscription
 * before the next paint — a stale toggle reads "off" while the applied state is "on"
 * (the Agent Teams toggle defect, 2026-11-18 repro). The daemon's own delta still
 * corrects the record when it arrives.
 */
export function mergeOptionValue(
  options: ProviderOptions | undefined,
  key: string,
  value: unknown,
): ProviderOptions {
  return { ...options, [key]: value };
}
