import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { CommandError } from "../output/index.js";

export type AgentFeatureValues = Record<string, boolean | string>;

export const FEATURE_OPTION_DESCRIPTION =
  "Set a provider feature as id=value, e.g. service_tier=priority (can be used multiple times)";

/** Parses repeated `--feature id=value` flags; the last value of an id wins. */
export function parseFeatureFlags(flags: string[] | undefined): Record<string, string> {
  // No prototype, so an id such as __proto__ is kept and reported as unknown.
  const requested: Record<string, string> = Object.create(null);
  for (const flag of flags ?? []) {
    const eqIndex = flag.indexOf("=");
    if (eqIndex === -1) {
      throw invalidFormat(flag);
    }
    const id = flag.slice(0, eqIndex).trim();
    const value = flag.slice(eqIndex + 1).trim();
    if (!id || !value) {
      throw invalidFormat(flag);
    }
    requested[id] = value;
  }
  return requested;
}

function invalidFormat(flag: string): CommandError {
  return {
    code: "INVALID_FEATURE",
    message: `Invalid feature format: ${flag}`,
    details: "Features must be in id=value format",
  };
}

/**
 * Checks requested values against the features the provider reports for this agent or draft and
 * converts them to the feature's value type: `true`/`false` for a toggle, an option id for a
 * select. Unknown ids and values fail with the valid choices.
 */
export function resolveFeatureValues(
  requested: Record<string, string>,
  features: readonly AgentFeature[],
): AgentFeatureValues {
  const values: AgentFeatureValues = {};
  for (const [id, raw] of Object.entries(requested)) {
    const feature = features.find((candidate) => candidate.id === id);
    if (!feature) {
      throw unknownFeature(id, features);
    }
    if (feature.type === "toggle") {
      if (raw !== "true" && raw !== "false") {
        throw invalidValue(feature, raw);
      }
      values[id] = raw === "true";
    } else {
      if (!feature.options.some((option) => option.id === raw)) {
        throw invalidValue(feature, raw);
      }
      values[id] = raw;
    }
  }
  return values;
}

/** `id=value` pairs of an agent's current features, for command output. */
export function formatFeatureValues(features: readonly AgentFeature[] | undefined): string {
  if (!features || features.length === 0) {
    return "-";
  }
  return features.map((feature) => `${feature.id}=${feature.value ?? "-"}`).join(",");
}

function allowedValues(feature: AgentFeature): string {
  if (feature.type === "toggle") {
    return "true|false";
  }
  return feature.options.map((option) => option.id).join("|");
}

function unknownFeature(id: string, features: readonly AgentFeature[]): CommandError {
  let details = "This provider and model expose no features";
  if (features.length > 0) {
    details = `Available features: ${features.map(describeFeature).join("; ")}`;
  }
  return { code: "INVALID_FEATURE", message: `Unknown feature: ${id}`, details };
}

function describeFeature(feature: AgentFeature): string {
  return `${feature.id}=${allowedValues(feature)}`;
}

function invalidValue(feature: AgentFeature, raw: string): CommandError {
  return {
    code: "INVALID_FEATURE",
    message: `Invalid value for feature ${feature.id}: ${raw}`,
    details: `Use ${describeFeature(feature)}`,
  };
}
