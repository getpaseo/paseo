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

export function pruneControlValues(
  controlValues: Record<string, unknown>,
  controls: AgentComposerControl[],
): Record<string, unknown> {
  const allowedControlIds = new Set(controls.filter(isValueControl).map((control) => control.id));
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [controlId, value] of Object.entries(controlValues)) {
    if (!allowedControlIds.has(controlId)) {
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
    return {
      ...control,
      value: controlValues[control.id],
    } as AgentComposerControl;
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
    if (Object.prototype.hasOwnProperty.call(args.localControlValues, control.id)) {
      next[control.id] = args.localControlValues[control.id];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.persistedControlValues, control.id)) {
      next[control.id] = args.persistedControlValues[control.id];
    }
  }

  return next;
}
