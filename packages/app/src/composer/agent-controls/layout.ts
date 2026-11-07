import {
  TOOLBAR_CONTROL_GAPS,
  TOOLBAR_CONTROL_SIZES,
  toolbarGlyphsFor,
  type ControlSizing,
  type ToolbarGlyphs,
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
  /** Plugin composer items. Each is budgeted like a select with a short label. */
  pluginItems: number;
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

/** What each toolbar control takes up in the row, which is what the density budget sums. */
export interface ComposerToolbarGeometry {
  /** An icon-only control's width in the row. */
  controlSize: number;
  glyphs: ToolbarGlyphs;
  controlGap: number;
  iconLabelGap: number;
  /** A labelled control's padding on each side, as far as it takes room in the row. */
  labelPadding: number;
  caretSize: number;
}

/**
 * The toolbar's measurements under a control sizing; see `resolveControlSizing`. Touch-sized a
 * control lays out at the width of what it paints (`toolbarSlot`, `toolbarContentSlot`), so an
 * icon-only control takes its glyph's width and a picker's padding takes no room.
 */
export function composerToolbarGeometry(sizing: ControlSizing): ComposerToolbarGeometry {
  const glyphs = toolbarGlyphsFor(sizing);
  const isTouch = sizing === "touch";
  return {
    controlSize: isTouch ? glyphs.icon.size : TOOLBAR_CONTROL_SIZES.pointer,
    glyphs,
    controlGap: TOOLBAR_CONTROL_GAPS[sizing],
    iconLabelGap: 4,
    labelPadding: isTouch ? 0 : 8,
    caretSize: 14,
  };
}

const DENSITY_HYSTERESIS = 12;
const PLUGIN_ITEM_LABEL = "Plugin item";
/** The model label's narrowest useful width: enough for the model family, such as "GPT-6…". */
const MODEL_FAMILY_LABEL_WIDTH = 56;

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
  return geometry.labelPadding * 2 + geometry.glyphs.label.size + geometry.iconLabelGap;
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
  if (controls.features.length > 0 || controls.pluginItems > 0) {
    widths.push(geometry.controlSize);
  }
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
  for (let index = 0; index < controls.pluginItems; index++) {
    widths.push(
      resolveFeatureControlWidth({ type: "select", label: PLUGIN_ITEM_LABEL }, fontScale, geometry),
    );
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
  if (controls.features.length > 0 || controls.pluginItems > 0) {
    widths.push(geometry.controlSize);
  }
  return sumControlWidths(widths, geometry);
}

/**
 * One model control carrying the model family label. Its thinking label is not budgeted: it is
 * the first label to go when the control runs out of room; see `resolveModelTriggerLabels`.
 */
function resolveCompactFloor(
  controls: ComposerControlPresence,
  geometry: ComposerToolbarGeometry,
): number {
  const fontScale = normalizedFontScale(controls.fontScale);
  return labelledChrome(geometry) + MODEL_FAMILY_LABEL_WIDTH * fontScale;
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

/**
 * Which labels the folded model control shows. `measuring` until every width is known, so the
 * control never paints a choice made without them.
 */
export type ModelTriggerLabels = "measuring" | "modelAndThinking" | "model";

/** Widths measured from the rendered model control, in points. */
export interface ModelTriggerMeasurements {
  /** The width the control may take. */
  availableWidth: number;
  /** The control with its model and thinking labels side by side, untruncated. */
  fullWidth: number;
}

/**
 * The thinking label goes first: it shows only while the model label fits beside it in full, so
 * the model label truncates only once the thinking label is gone. The web reports layout widths
 * rounded to whole pixels, so equal widths can hide a fraction of a pixel of overflow; only a
 * full width strictly below the available width is known to fit.
 */
export function resolveModelTriggerLabels(input: {
  hasThinking: boolean;
  measurements: Partial<ModelTriggerMeasurements>;
}): ModelTriggerLabels {
  if (!input.hasThinking) return "model";
  const { availableWidth, fullWidth } = input.measurements;
  if (availableWidth === undefined || fullWidth === undefined) return "measuring";
  return fullWidth < availableWidth ? "modelAndThinking" : "model";
}
