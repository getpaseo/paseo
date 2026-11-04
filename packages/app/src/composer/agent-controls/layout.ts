import {
  iconSizeFor,
  TOOLBAR_CONTROL_SIZES,
  type ControlSizing,
} from "@/components/ui/control-geometry";

/**
 * How much of the toolbar shows, widest first. Each step drops something before the next:
 * carets and labels, then the mode label, then the thinking, mode and feature controls fold into
 * the model control's sheet (`compact`, the phone toolbar), then the model's own label.
 */
export type ComposerControlDensity = "full" | "condensed" | "tight" | "compact" | "iconOnly";

const DENSITY_LADDER: readonly ComposerControlDensity[] = [
  "full",
  "condensed",
  "tight",
  "compact",
  "iconOnly",
];

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
  /** Thinking, mode and features live in the model control's sheet. */
  foldControls: boolean;
  showModelLabel: boolean;
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
/** The model label's narrowest useful width: enough for the model family, such as "GPT-6…". */
const MODEL_FAMILY_LABEL_WIDTH = 56;
/** A thinking label beside the folded model label, such as "Medium". */
const THINKING_LABEL_WIDTH = 48;

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

/** Model at its family label, with thinking, mode and features as icon-only squares. */
function resolveTightFloor(
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const widths: number[] = [];
  if (controls.hasModel) {
    widths.push(labelledChrome(geometry) + MODEL_FAMILY_LABEL_WIDTH * fontScale);
  }
  if (controls.hasThinking) widths.push(geometry.controlSize);
  if (controls.hasMode) widths.push(geometry.controlSize);
  if (controls.features.length > 0) widths.push(geometry.controlSize);
  return sumControlWidths(widths, geometry);
}

/** One model control carrying the model family label and the thinking label. */
function resolveCompactFloor(
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  const thinkingLabel = controls.hasThinking
    ? geometry.iconLabelGap + THINKING_LABEL_WIDTH * fontScale
    : 0;
  return labelledChrome(geometry) + MODEL_FAMILY_LABEL_WIDTH * fontScale + thinkingLabel;
}

function resolveDensityFloor(
  density: ComposerControlDensity,
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  switch (density) {
    case "full":
      return resolveFullFloor(controls, geometry);
    case "condensed":
      return resolveCondensedFloor(controls, geometry);
    case "tight":
      return resolveTightFloor(controls, geometry);
    case "compact":
      return resolveCompactFloor(controls, geometry);
    case "iconOnly":
      return 0;
  }
}

/**
 * The widest density whose floor fits `availableWidth`. Widening past the current density needs
 * the floor plus the hysteresis and keeping it tolerates the floor minus it, so a width near a
 * floor does not flip back and forth. `minimumDensity` is the widest density allowed.
 */
export function resolveComposerControlDensity(input: {
  availableWidth: number;
  currentDensity: ComposerControlDensity;
  controls: ComposerControlPresence;
  geometry: ComposerToolbarGeometry;
  minimumDensity?: ComposerControlDensity;
}): ComposerControlDensity {
  const current = DENSITY_LADDER.indexOf(input.currentDensity);
  const first = DENSITY_LADDER.indexOf(input.minimumDensity ?? "full");
  for (let step = first; step < DENSITY_LADDER.length; step += 1) {
    const density = DENSITY_LADDER[step];
    const floor = resolveDensityFloor(density, input.controls, input.geometry);
    let required = floor;
    if (step < current) required = floor + DENSITY_HYSTERESIS;
    if (step === current) required = floor - DENSITY_HYSTERESIS;
    if (input.availableWidth >= required) return density;
  }
  return "iconOnly";
}

const PRESENTATIONS: Record<ComposerControlDensity, ComposerControlPresentation> = {
  full: {
    showCarets: true,
    showThinkingLabel: true,
    showModeLabel: true,
    aggregateFeatures: false,
    foldControls: false,
    showModelLabel: true,
  },
  condensed: {
    showCarets: false,
    showThinkingLabel: false,
    showModeLabel: true,
    aggregateFeatures: true,
    foldControls: false,
    showModelLabel: true,
  },
  tight: {
    showCarets: false,
    showThinkingLabel: false,
    showModeLabel: false,
    aggregateFeatures: true,
    foldControls: false,
    showModelLabel: true,
  },
  compact: {
    showCarets: false,
    showThinkingLabel: true,
    showModeLabel: false,
    aggregateFeatures: true,
    foldControls: true,
    showModelLabel: true,
  },
  iconOnly: {
    showCarets: false,
    showThinkingLabel: false,
    showModeLabel: false,
    aggregateFeatures: true,
    foldControls: true,
    showModelLabel: false,
  },
};

export function resolveComposerControlPresentation(
  density: ComposerControlDensity,
): ComposerControlPresentation {
  return PRESENTATIONS[density];
}
