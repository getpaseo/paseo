import { isDeepStrictEqual } from "node:util";
import type {
  AgentFeature,
  AgentOptionControl,
  AgentOptionSelectControl,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";

/**
 * A patch over an agent's own options: top-level keys replace, `null` removes the key so the
 * `config.json` default (or the provider's own default) applies again.
 */
export type ProviderOptionsPatch = Record<string, unknown>;

export function applyProviderOptionsPatch(
  own: ProviderOptions | undefined,
  patch: ProviderOptionsPatch,
): ProviderOptions {
  const next: ProviderOptions = { ...own };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/** COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. */
export interface LegacyFeatureValues {
  featureValues?: Record<string, unknown>;
}

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Older clients, stored records, profiles, and plugin hooks carry composer values in
 * `featureValues`. This is the one place they become `providerOptions`; an explicit
 * `providerOptions` key wins over a `featureValues` key of the same name.
 */
export function foldFeatureValues<
  T extends {
    providerOptions?: ProviderOptions | null;
    featureValues?: Record<string, unknown> | null;
  },
>(input: T): Omit<T, "featureValues"> {
  const { featureValues, ...rest } = input;
  if (!featureValues || Object.keys(featureValues).length === 0) {
    return rest;
  }
  return { ...rest, providerOptions: { ...featureValues, ...rest.providerOptions } };
}

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * A plugin written against the previous SDK reads and edits `config.featureValues`, so a
 * hook sees a copy of the config's options there. What the hook did to that copy (set,
 * replaced or deleted a key, or dropped the field) is applied as a patch over the options it
 * returned; keys it left alone change nothing.
 */
export function exposeFeatureValuesToHook<
  T extends { providerOptions?: ProviderOptions | null; featureValues?: Record<string, unknown> },
>(config: T): T {
  if (!config.providerOptions || Object.keys(config.providerOptions).length === 0) return config;
  return { ...config, featureValues: { ...config.providerOptions } };
}

export function foldHookFeatureValues<
  T extends { providerOptions?: ProviderOptions | null; featureValues?: Record<string, unknown> },
>(returned: T, sent: T): Omit<T, "featureValues"> {
  const { featureValues, ...rest } = returned;
  const before = sent.featureValues;
  if (!before) {
    // No copy was sent, so everything the hook put in `featureValues` is new.
    return { ...rest, providerOptions: { ...featureValues, ...rest.providerOptions } };
  }
  const after = featureValues ?? {};
  const patch: ProviderOptionsPatch = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(after[key], before[key])) continue;
    patch[key] = key in after ? after[key] : null;
  }
  return {
    ...rest,
    providerOptions: applyProviderOptionsPatch(rest.providerOptions ?? undefined, patch),
  };
}

interface ProfileOptionFields {
  options?: Record<string, unknown>;
  featureValues?: Record<string, unknown>;
}

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Profiles saved before options carry `featureValues`; when one comes from storage, `options`
 * wins over a stale `featureValues` key.
 *
 * A profile written by the unchanged app is a patch: its form only knows the controls, so its
 * `featureValues` are applied over the options already stored for that profile (`null`
 * deletes), and options the form never shows, such as `sandbox_mode`, survive an edit.
 */
export function foldProfileFeatureValues<T extends ProfileOptionFields>(
  profile: T,
  stored: Record<string, unknown> | undefined,
  source: "stored" | "client write" = "stored",
): Omit<T, "featureValues"> {
  const { featureValues, ...rest } = profile;
  if (source === "stored") {
    return featureValues ? { ...rest, options: { ...featureValues, ...rest.options } } : rest;
  }
  // The form sends no `featureValues` when no control is set, which is still an edit of a
  // profile that may hold other options.
  if (!featureValues && (rest.options || !stored)) return rest;
  return {
    ...rest,
    options: applyProviderOptionsPatch(stored ?? rest.options, featureValues ?? {}),
  };
}

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * The unchanged app reads a profile's options from `featureValues`; the config API answers with
 * both fields.
 */
export function withLegacyProfileFeatureValues<T extends ProfileOptionFields>(profile: T): T {
  return profile.options ? { ...profile, featureValues: { ...profile.options } } : profile;
}

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

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Apps that predate controls render `features`; build them from controls + effective options.
 */
export function featuresFromControls(
  controls: readonly AgentOptionControl[] | undefined,
  options: ProviderOptions | undefined,
): AgentFeature[] {
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

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Agent records written before controls stored `features`; their descriptors become controls.
 */
export function controlsFromFeatures(
  features: readonly AgentFeature[] | undefined,
): AgentOptionControl[] {
  return (features ?? []).map(controlFromFeature);
}
