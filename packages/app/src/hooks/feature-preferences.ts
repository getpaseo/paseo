import type { AgentComposerControl, AgentFeature } from "@getpaseo/protocol/agent-types";

export function pruneFeatureValues(
  featureValues: Record<string, unknown>,
  features: AgentFeature[],
): Record<string, unknown> {
  const allowedFeatureIds = new Set(features.map((feature) => feature.id));
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [featureId, value] of Object.entries(featureValues)) {
    if (!allowedFeatureIds.has(featureId)) {
      changed = true;
      continue;
    }
    next[featureId] = value;
  }

  return changed ? next : featureValues;
}

export function applyFeatureValues(
  features: AgentFeature[],
  featureValues: Record<string, unknown>,
): AgentFeature[] {
  if (Object.keys(featureValues).length === 0) {
    return features;
  }

  return features.map((feature) => {
    if (!Object.prototype.hasOwnProperty.call(featureValues, feature.id)) {
      return feature;
    }

    return {
      ...feature,
      value: featureValues[feature.id],
    } as AgentFeature;
  });
}

export function resolveFeatureValues(args: {
  features: AgentFeature[];
  persistedFeatureValues: Record<string, unknown>;
  localFeatureValues: Record<string, unknown>;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const feature of args.features) {
    if (Object.prototype.hasOwnProperty.call(args.localFeatureValues, feature.id)) {
      next[feature.id] = args.localFeatureValues[feature.id];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.persistedFeatureValues, feature.id)) {
      next[feature.id] = args.persistedFeatureValues[feature.id];
    }
  }

  return next;
}

function isValueControl(
  control: AgentComposerControl,
): control is Extract<AgentComposerControl, { kind: "toggle" | "select" }> {
  return control.kind === "toggle" || control.kind === "select";
}

/** Stable serialization for query keys: control ids sorted, values as JSON. */
export function serializeControlValues(values: Record<string, unknown> | undefined): string {
  if (!values) return "";
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key];
  return JSON.stringify(sorted);
}

/** A held value only applies when it matches the control kind (and, for
 * selects, names a current option). Stored values are `unknown`, so check
 * instead of casting. */
function isValidControlValue(
  control: Extract<AgentComposerControl, { kind: "toggle" | "select" }>,
  value: unknown,
): boolean {
  if (control.kind === "toggle") return typeof value === "boolean";
  if (value === null) return true;
  return typeof value === "string" && control.options.some((option) => option.id === value);
}

export function pruneControlValues(
  controlValues: Record<string, unknown>,
  controls: AgentComposerControl[],
): Record<string, unknown> {
  const valueControls = new Map(
    controls.filter(isValueControl).map((control) => [control.id, control] as const),
  );
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [controlId, value] of Object.entries(controlValues)) {
    const control = valueControls.get(controlId);
    if (!control || !isValidControlValue(control, value)) {
      changed = true;
      continue;
    }
    next[controlId] = value;
  }

  return changed ? next : controlValues;
}

export function applyControlValues(
  controls: AgentComposerControl[],
  controlValues: Record<string, unknown>,
): AgentComposerControl[] {
  if (Object.keys(controlValues).length === 0) {
    return controls;
  }

  return controls.map((control) => {
    if (!isValueControl(control)) return control;
    if (!Object.prototype.hasOwnProperty.call(controlValues, control.id)) {
      return control;
    }
    const value = controlValues[control.id];
    if (!isValidControlValue(control, value)) return control;
    return control.kind === "toggle"
      ? { ...control, value: value as boolean }
      : { ...control, value: value as string | null };
  });
}

export function resolveControlValues(args: {
  controls: AgentComposerControl[];
  persistedControlValues: Record<string, unknown>;
  localControlValues: Record<string, unknown>;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const control of args.controls) {
    if (!isValueControl(control)) continue;
    if (
      Object.prototype.hasOwnProperty.call(args.localControlValues, control.id) &&
      isValidControlValue(control, args.localControlValues[control.id])
    ) {
      next[control.id] = args.localControlValues[control.id];
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(args.persistedControlValues, control.id) &&
      isValidControlValue(control, args.persistedControlValues[control.id])
    ) {
      next[control.id] = args.persistedControlValues[control.id];
    }
  }

  return next;
}
