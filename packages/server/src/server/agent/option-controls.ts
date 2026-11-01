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

export function applyProviderOptionsPatch(input: {
  options: ProviderOptions | undefined;
  patch: ProviderOptionsPatch;
}): ProviderOptions {
  const { options, patch } = input;
  const next: ProviderOptions = { ...options };
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
 * COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast
 * preferences have migrated. Codex used to take `fast_mode`; it takes `service_tier` now. Old
 * data (stored records, config.json defaults, profiles, older clients, hooks) is converted here
 * as it enters, so nothing past this point sees `fast_mode` for Codex. A `service_tier` in the
 * same input wins. A patch's `null` stays `null`, which removes the speed.
 */
interface LegacyOptionsInput<O> {
  provider: string | undefined;
  options: O;
}

export function convertLegacyOptions(
  input: LegacyOptionsInput<Record<string, unknown>>,
): Record<string, unknown>;
export function convertLegacyOptions(
  input: LegacyOptionsInput<Record<string, unknown> | undefined>,
): Record<string, unknown> | undefined;
export function convertLegacyOptions(
  input: LegacyOptionsInput<Record<string, unknown> | undefined>,
): Record<string, unknown> | undefined {
  const { provider, options } = input;
  if (provider !== "codex" || !options || !("fast_mode" in options)) return options;
  const { fast_mode: legacy, ...rest } = options;
  if (legacy !== undefined && legacy !== null && typeof legacy !== "boolean") {
    throw new Error("Codex fast_mode must be true, false or null");
  }
  if ("service_tier" in rest || legacy === undefined) return rest;
  if (legacy === null) return { ...rest, service_tier: null };
  return { ...rest, service_tier: legacy ? "fast" : "default" };
}

/**
 * The built-in adapter a provider id runs on: a custom provider is named by the one it
 * `extends`, followed until a provider that extends nothing. `extendsOf` is where the caller
 * reads that link (the registry's definitions, or `config.json`'s `providers` section).
 */
export function resolveAdapter(input: {
  provider: string;
  extendsOf: (provider: string) => string | null | undefined;
}): string {
  const seen = new Set<string>();
  let current = input.provider;
  for (;;) {
    seen.add(current);
    const base = input.extendsOf(current);
    if (!base || seen.has(base)) return current;
    current = base;
  }
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
>(config: T): Omit<T, "featureValues"> {
  const { featureValues, ...rest } = config;
  if (!featureValues || Object.keys(featureValues).length === 0) return rest;
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
  T extends {
    providerOptions?: ProviderOptions | null;
    featureValues?: Record<string, unknown>;
  },
>(input: {
  returned: T;
  sent: T;
  /** Brings what the hook returned to the form of the copy it was sent. */
  convert: (options: Record<string, unknown>) => Record<string, unknown>;
}): Omit<T, "featureValues"> {
  const { returned, sent, convert } = input;
  const { featureValues, ...rest } = returned;
  const before = sent.featureValues;
  if (!before) {
    // No copy was sent, so everything the hook put in `featureValues` is new.
    return foldFeatureValues(returned);
  }
  // A hook may return an older key where it was sent the current one; comparing in the same
  // form keeps a replaced value from reading as a deletion.
  const after = convert(featureValues ?? {});
  const patch: ProviderOptionsPatch = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(after[key], before[key])) continue;
    patch[key] = key in after ? after[key] : null;
  }
  return {
    ...rest,
    providerOptions: applyProviderOptionsPatch({
      options: rest.providerOptions ?? undefined,
      patch,
    }),
  };
}

type ConvertedOptions = Record<string, unknown> | undefined;

interface ProfileOptionFields {
  provider?: string;
  options?: Record<string, unknown>;
  featureValues?: Record<string, unknown>;
}

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Profiles saved before options carry `featureValues`; when one comes from storage, `options`
 * wins over a stale `featureValues` key.
 *
 * A write that carries `options` is from a client that knows them: its `featureValues` fold
 * over those. A write without `options` is from the unchanged app, whose form only knows the
 * controls: its `featureValues` are a patch (`null` deletes) over the options stored for that
 * profile, so options the form never shows, such as `sandbox_mode`, survive an edit. A profile
 * moved to another provider starts from no options, because the old provider's keys mean
 * nothing to the new one.
 */
export function foldProfileFeatureValues<T extends ProfileOptionFields>(input: {
  profile: T;
  stored: ProfileOptionFields | undefined;
  source: "stored" | "client write";
  /** Renames old option keys for the adapter the profile's provider runs on. */
  convert: (provider: string, options: Record<string, unknown> | undefined) => ConvertedOptions;
}): Omit<T, "featureValues"> {
  const { profile, stored, source, convert } = input;
  const { featureValues: legacyValues, ...rest } = profile;
  // A profile is stored in the current keys, so removal and merging below see one vocabulary.
  const provider = rest.provider ?? "";
  const featureValues = convert(provider, legacyValues);
  const ownOptions = convert(provider, rest.options);
  if (source === "stored") {
    if (featureValues) return { ...rest, options: { ...featureValues, ...ownOptions } };
    return ownOptions ? { ...rest, options: ownOptions } : rest;
  }
  const base =
    ownOptions ??
    (stored?.provider === rest.provider ? convert(provider, stored?.options) : undefined);
  // The form sends no `featureValues` when no control is set, which is still an edit of a
  // profile that may hold other options.
  if (!featureValues && !base) return rest;
  return {
    ...rest,
    options: applyProviderOptionsPatch({ options: base, patch: featureValues ?? {} }),
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

/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Agent records written before controls stored `features`; their descriptors become controls.
 */
export function controlsFromFeatures(
  features: readonly AgentFeature[] | undefined,
): AgentOptionControl[] {
  return (features ?? []).map(controlFromFeature);
}
