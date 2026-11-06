import {
  TOOLBAR_CONTROL_SIZES,
  TOOLBAR_DISC_SIZES,
  toolbarGlyphsFor,
  type ControlSizing,
} from "@/components/ui/control-geometry";
import { composerToolbarGeometry } from "@/composer/agent-controls/layout";

/** The control at one end of the composer toolbar, which decides how far the row hangs out. */
export type ComposerToolbarEdge = "attach" | "label" | "dictation" | "voiceMode" | "disc" | "none";

/**
 * How far each outline glyph's ink sits in from its box, on Lucide's 24-unit grid. Optical:
 * read from the icon paths (Plus and Mic span 5-19, AudioLines 2-22, each with a 2-unit stroke).
 */
const GLYPH_BEARINGS = { attach: 4, dictation: 4, voiceMode: 1 } as const;
const LUCIDE_GRID = 24;

/** Pointer-sized the row hangs a flat 6px into the padding, which puts each 16pt glyph box on the rail. */
const POINTER_OVERHANG = 6;

/**
 * How far the composer toolbar hangs past the text column at one end. Touch-sized, the end
 * control's ink, or its disc's edge, sits on the text column's edge while its 44pt slot reaches
 * into the composer padding, so the toolbar and the prompt share one pair of rails.
 */
export function composerToolbarOverhang(edge: ComposerToolbarEdge, sizing: ControlSizing): number {
  if (sizing === "pointer" || edge === "none") return POINTER_OVERHANG;
  const slot = TOOLBAR_CONTROL_SIZES.touch;
  if (edge === "disc") return (slot - TOOLBAR_DISC_SIZES.touch) / 2;
  if (edge === "label") return composerToolbarGeometry("touch").labelPadding;
  const glyph = toolbarGlyphsFor("touch").icon.size;
  return (slot - glyph) / 2 + (GLYPH_BEARINGS[edge] * glyph) / LUCIDE_GRID;
}

/** The control that ends the toolbar on the right, from what the row shows. */
export function resolveComposerTrailingEdge(input: {
  hasPrimaryAction: boolean;
  showsVoiceMode: boolean;
  showsDictation: boolean;
  isDictating: boolean;
}): ComposerToolbarEdge {
  if (input.hasPrimaryAction) return "disc";
  if (input.showsVoiceMode) return "voiceMode";
  if (input.showsDictation) return input.isDictating ? "disc" : "dictation";
  return "none";
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
