import {
  TOOLBAR_CONTROL_SIZES,
  TOOLBAR_DISC_SIZES,
  TOOLBAR_LABEL_PADDING,
  toolbarGlyphsFor,
  type ControlSizing,
} from "@/components/ui/control-geometry";
import { bySizing } from "@/components/ui/control-sizing";

/** The control at one end of the composer toolbar, which decides how far the row hangs out. */
export type ComposerToolbarEdge = "attach" | "label" | "disc" | "none";

/**
 * The composer's padding. Its sides are the rails: the text column and the toolbar's outer
 * controls both start there.
 */
const COMPOSER_PADDING = {
  touch: { top: 12, horizontal: 16, bottom: 4 },
  pointer: { top: 16, horizontal: 16, bottom: 12 },
} as const;

export const COMPOSER_PADDING_TOP = bySizing({
  touch: COMPOSER_PADDING.touch.top,
  pointer: COMPOSER_PADDING.pointer.top,
});
export const COMPOSER_PADDING_HORIZONTAL = bySizing({
  touch: COMPOSER_PADDING.touch.horizontal,
  pointer: COMPOSER_PADDING.pointer.horizontal,
});
export const COMPOSER_PADDING_BOTTOM = bySizing({
  touch: COMPOSER_PADDING.touch.bottom,
  pointer: COMPOSER_PADDING.pointer.bottom,
});

/** The plus glyph's ink: 14 of Lucide's 24 units, plus its stroke. */
function attachGlyphInkWidth(): number {
  const glyph = toolbarGlyphsFor("touch").icon;
  return (14 * glyph.size) / 24 + glyph.strokeWidth;
}

/** Pointer-sized the row hangs a flat 6px into the padding, which puts each 16pt glyph box on the rail. */
const POINTER_OVERHANG = 6;

/** How far a touch-sized disc sits from the composer's bottom edge, centred in the toolbar row. */
const DISC_EDGE_INSET =
  COMPOSER_PADDING.touch.bottom + (TOOLBAR_CONTROL_SIZES.touch - TOOLBAR_DISC_SIZES.touch) / 2;

/**
 * A trailing disc nests into the composer's corner: it reaches past the rail until it sits as far
 * from the right edge as from the bottom edge.
 */
const DISC_CORNER_NEST = COMPOSER_PADDING.touch.horizontal - DISC_EDGE_INSET;

/** Touch-sized the composer's corner is concentric with the disc nested in it. */
export const COMPOSER_CORNER_RADIUS = bySizing({
  touch: TOOLBAR_DISC_SIZES.touch / 2 + DISC_EDGE_INSET,
  pointer: 16,
});

/**
 * Touch-sized each end control's highlight hangs past the rail far enough to put what it paints on
 * the rail. The trailing disc paints its whole highlight, so it nests into the corner instead.
 */
const TOUCH_OVERHANGS: Record<ComposerToolbarEdge, number> = {
  attach: (TOOLBAR_DISC_SIZES.touch - attachGlyphInkWidth()) / 2,
  label: TOOLBAR_LABEL_PADDING,
  disc: DISC_CORNER_NEST,
  none: 0,
};

/** How far the composer toolbar hangs past the text column at one end. */
export function composerToolbarOverhang(edge: ComposerToolbarEdge, sizing: ControlSizing): number {
  return sizing === "pointer" ? POINTER_OVERHANG : TOUCH_OVERHANGS[edge];
}

/** The control that starts the toolbar on the left. */
export function resolveComposerLeadingEdge(input: {
  showsAttach: boolean;
  showsAgentControls: boolean;
}): ComposerToolbarEdge {
  if (input.showsAttach) return "attach";
  if (input.showsAgentControls) return "label";
  return "none";
}
