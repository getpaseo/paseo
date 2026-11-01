import type {
  AgentFeature,
  AgentOptionControl,
  AgentOptionSelectControl,
  ProviderOptions,
} from "./agent-types.js";

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
// `features` are controls with their value attached. The daemon builds them for apps that
// predate controls, and the client package rebuilds controls and options from them when it
// talks to a daemon that predates controls. Both directions live here so they stay inverse.

function selectedChoice(control: AgentOptionSelectControl, options: ProviderOptions) {
  const value = options[control.key];
  if (typeof value === "string") {
    const choice = control.choices.find((candidate) => candidate.value === value);
    if (choice) return choice.value;
  }
  return control.defaultValue ?? null;
}

function describe(control: { description?: string; tooltip?: string; icon?: string }): {
  description?: string;
  tooltip?: string;
  icon?: string;
} {
  return {
    ...(control.description !== undefined ? { description: control.description } : {}),
    ...(control.tooltip !== undefined ? { tooltip: control.tooltip } : {}),
    ...(control.icon !== undefined ? { icon: control.icon } : {}),
  };
}

function featureFromControl(control: AgentOptionControl, effective: ProviderOptions): AgentFeature {
  if (control.type === "toggle") {
    const value = effective[control.key];
    return {
      type: "toggle",
      id: control.key,
      label: control.label,
      ...describe(control),
      value: typeof value === "boolean" ? value : (control.defaultValue ?? false),
    };
  }
  return {
    type: "select",
    id: control.key,
    label: control.label,
    ...describe(control),
    ...(control.desktopTrigger ? { desktopTrigger: control.desktopTrigger } : {}),
    value: selectedChoice(control, effective),
    options: control.choices.map((choice) => ({
      id: choice.value,
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
      ...(choice.value === control.defaultValue ? { isDefault: true } : {}),
    })),
  };
}

/** Apps that predate controls render `features`; build them from controls + effective options. */
export function featuresFromControls(input: {
  controls: readonly AgentOptionControl[] | undefined;
  options: ProviderOptions | undefined;
}): AgentFeature[] {
  const { controls, options } = input;
  const effective = options ?? {};
  return (controls ?? []).map((control) => featureFromControl(control, effective));
}

/** A recorded feature's value is not carried over: controls hold no state, only `options` do. */
function controlFromFeature(feature: AgentFeature): AgentOptionControl {
  const descriptor = {
    key: feature.id,
    label: feature.label,
    ...describe(feature),
  };
  if (feature.type === "toggle") {
    return { type: "toggle", ...descriptor };
  }
  const defaultChoice = feature.options.find((option) => option.isDefault);
  return {
    type: "select",
    ...descriptor,
    ...(feature.desktopTrigger ? { desktopTrigger: feature.desktopTrigger } : {}),
    ...(defaultChoice ? { defaultValue: defaultChoice.id } : {}),
    choices: feature.options.map((option) => ({
      value: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

/** Agent records and daemons that predate controls carry `features`; their descriptors become controls. */
export function controlsFromFeatures(
  features: readonly AgentFeature[] | undefined,
): AgentOptionControl[] {
  return (features ?? []).map(controlFromFeature);
}

/** The options a list of `features` stands for: each feature's value under its id. */
export function optionsFromFeatures(
  features: readonly AgentFeature[] | undefined,
): ProviderOptions {
  return Object.fromEntries((features ?? []).map((feature) => [feature.id, feature.value]));
}
