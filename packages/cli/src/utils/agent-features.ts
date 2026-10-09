import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { CommandError } from "../output/index.js";

export type AgentFeatureValues = Record<string, boolean | string>;

export const FEATURE_OPTION_DESCRIPTION =
  "Set a provider feature as id=value, e.g. service_tier=priority (can be used multiple times)";

/** Parses repeated `--feature id=value` flags; the last value of an id wins. */
export function parseFeatureFlags(flags: string[] | undefined): Record<string, string> {
  const requested: Record<string, string> = {};
  for (const flag of flags ?? []) {
    const eqIndex = flag.indexOf("=");
    const id = eqIndex === -1 ? "" : flag.slice(0, eqIndex).trim();
    const value = eqIndex === -1 ? "" : flag.slice(eqIndex + 1).trim();
    if (!id || !value) {
      throw {
        code: "INVALID_FEATURE",
        message: `Invalid feature format: ${flag}`,
        details: "Features must be in id=value format",
      } satisfies CommandError;
    }
    requested[id] = value;
  }
  return requested;
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
      throw {
        code: "INVALID_FEATURE",
        message: `Unknown feature: ${id}`,
        details:
          features.length > 0
            ? `Available features: ${features.map(describeFeature).join("; ")}`
            : "This provider and model expose no features",
      } satisfies CommandError;
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
  return feature.type === "toggle"
    ? "true|false"
    : feature.options.map((option) => option.id).join("|");
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
