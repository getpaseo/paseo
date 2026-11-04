import {
  iconSizeFor,
  TOOLBAR_CONTROL_SIZES,
  type ControlSizing,
} from "@/components/ui/control-geometry";

export type ComposerControlDensity = "full" | "condensed" | "tight";

export interface ComposerControlPresence {
  hasModel: boolean;
  hasThinking: boolean;
  hasMode: boolean;
  features: readonly ComposerFeatureControlPresence[];
  fontScale: number;
}

export type ComposerFeatureControlPresence = { type: "toggle" } | { type: "select"; label: string };

export interface ComposerControlPresentation {
  showCarets: boolean;
  showThinkingLabel: boolean;
  showModeLabel: boolean;
  aggregateFeatures: boolean;
}

export interface ComposerToolbarGeometry {
  controlSize: number;
  glyphSize: number;
  controlGap: number;
  iconLabelGap: number;
  labelPadding: number;
  caretSize: number;
}

/** The toolbar's measurements under a control sizing; see `resolveControlSizing`. */
export function composerToolbarGeometry(sizing: ControlSizing): ComposerToolbarGeometry {
  return {
    controlSize: TOOLBAR_CONTROL_SIZES[sizing],
    glyphSize: iconSizeFor("md")[sizing],
    controlGap: 4,
    iconLabelGap: 4,
    labelPadding: 8,
    caretSize: 14,
  };
}

const DENSITY_HYSTERESIS = 12;

function normalizedFontScale(fontScale: number): number {
  return Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
}

function sumControlWidths(widths: number[], geometry: ComposerToolbarGeometry): number {
  if (widths.length === 0) return 0;
  return (
    widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * geometry.controlGap
  );
}

function estimateLabelWidth(label: string, fontScale: number): number {
  return Array.from(label).length * 7 * fontScale;
}

/** A labelled control's fixed chrome: its padding, its glyph, and the gap to its label. */
function labelledChrome(geometry: ComposerToolbarGeometry): number {
  return geometry.labelPadding * 2 + geometry.glyphSize + geometry.iconLabelGap;
}

function resolveFeatureControlWidth(
  feature: ComposerFeatureControlPresence,
  fontScale: number,
  geometry: ComposerToolbarGeometry,
): number {
  if (feature.type === "toggle") return geometry.controlSize;
  return (
    geometry.controlSize +
    geometry.iconLabelGap +
    geometry.labelPadding * 2 +
    estimateLabelWidth(feature.label, fontScale)
  );
}

function resolveCondensedFloor(
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const chrome = labelledChrome(geometry);
  const widths: number[] = [];
  if (controls.hasModel) widths.push(chrome + 60 * fontScale);
  if (controls.hasThinking) widths.push(geometry.controlSize);
  if (controls.hasMode) widths.push(chrome + 96 * fontScale);
  if (controls.features.length > 0) widths.push(geometry.controlSize);
  return sumControlWidths(widths, geometry);
}

function resolveFullFloor(
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const chrome = labelledChrome(geometry);
  const caret = geometry.caretSize;
  const widths: number[] = [];
  if (controls.hasModel) widths.push(chrome + caret + 70 * fontScale);
  if (controls.hasThinking) widths.push(chrome + geometry.iconLabelGap + caret + 48 * fontScale);
  if (controls.hasMode) widths.push(chrome + geometry.iconLabelGap + caret + 96 * fontScale);
  for (const feature of controls.features) {
    widths.push(resolveFeatureControlWidth(feature, fontScale, geometry));
  }
  return sumControlWidths(widths, geometry);
}

export function resolveComposerControlDensity(input: {
  availableWidth: number;
  currentDensity: ComposerControlDensity;
  controls: ComposerControlPresence;
  geometry: ComposerToolbarGeometry;
}): ComposerControlDensity {
  const fullFloor = resolveFullFloor(input.controls, input.geometry);
  const condensedFloor = resolveCondensedFloor(input.controls, input.geometry);

  if (input.currentDensity === "full") {
    if (input.availableWidth >= fullFloor - DENSITY_HYSTERESIS) return "full";
    return input.availableWidth >= condensedFloor ? "condensed" : "tight";
  }

  if (input.currentDensity === "condensed") {
    if (input.availableWidth >= fullFloor + DENSITY_HYSTERESIS) return "full";
    if (input.availableWidth < condensedFloor - DENSITY_HYSTERESIS) return "tight";
    return "condensed";
  }

  if (input.availableWidth >= fullFloor + DENSITY_HYSTERESIS) return "full";
  if (input.availableWidth >= condensedFloor + DENSITY_HYSTERESIS) return "condensed";
  return "tight";
}

export function resolveComposerControlPresentation(
  density: ComposerControlDensity,
): ComposerControlPresentation {
  if (density === "full") {
    return {
      showCarets: true,
      showThinkingLabel: true,
      showModeLabel: true,
      aggregateFeatures: false,
    };
  }
  if (density === "condensed") {
    return {
      showCarets: false,
      showThinkingLabel: false,
      showModeLabel: true,
      aggregateFeatures: true,
    };
  }
  return {
    showCarets: false,
    showThinkingLabel: false,
    showModeLabel: false,
    aggregateFeatures: true,
  };
}
