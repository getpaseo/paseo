import type { ProjectGlyphChoice } from "@/projects/project-glyph-icon";

/**
 * Native has no canvas to flatten the tile with, so the glyph picker is offered on web and
 * desktop only. A glyph icon chosen there still shows on every client: it is stored as a PNG.
 */
export const canRenderProjectGlyph = false;

export function renderProjectGlyphPng(_choice: ProjectGlyphChoice): Promise<string> {
  return Promise.reject(new Error("Glyph icons can only be made on web and desktop"));
}
