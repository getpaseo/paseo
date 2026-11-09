import {
  TOOLBAR_CONTROL_SIZES,
  TOOLBAR_DISC_SIZES,
  TOOLBAR_RINGS,
  toolbarGlyphsFor,
  type ControlSizing,
} from "@/components/ui/control-geometry";
import { bySizing } from "@/components/ui/control-sizing";

/** The control at one end of the composer toolbar, which decides how far the row hangs out. */
export type ComposerToolbarEdge = "attach" | "label" | "dictation" | "voiceMode" | "disc" | "none";

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

/** How much of Lucide's 24-unit grid each toolbar glyph's ink spans, centred in its box. */
const GLYPH_INK_SPANS = { plus: 14, mic: 14, audioLines: 20 } as const;

function touchGlyphInkWidth(span: number): number {
  const glyph = toolbarGlyphsFor("touch").icon;
  return (span * glyph.size) / 24 + glyph.strokeWidth;
}

/** The width each toolbar control paints when touch-sized; the row spaces these. */
export const COMPOSER_TOOLBAR_SHAPES = {
  attach: touchGlyphInkWidth(GLYPH_INK_SPANS.plus),
  dictation: touchGlyphInkWidth(GLYPH_INK_SPANS.mic),
  voiceMode: touchGlyphInkWidth(GLYPH_INK_SPANS.audioLines),
  ring: TOOLBAR_RINGS.touch.size,
  disc: TOOLBAR_DISC_SIZES.touch,
} as const;

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

/** How far the composer toolbar hangs past the text column at one end. */
export function composerToolbarOverhang(edge: ComposerToolbarEdge, sizing: ControlSizing): number {
  if (sizing === "pointer") return POINTER_OVERHANG;
  return edge === "disc" ? DISC_CORNER_NEST : 0;
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
