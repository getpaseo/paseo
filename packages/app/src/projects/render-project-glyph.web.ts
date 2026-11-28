import { Buffer } from "buffer";
import {
  findProjectGlyph,
  GLYPH_TILE_PNG_SIZE,
  glyphTileSvg,
  type ProjectGlyphChoice,
  tagGlyphPng,
} from "@/projects/project-glyph-icon";

export const canRenderProjectGlyph = true;

/** Flattens the glyph tile to a tagged PNG and returns its base64, ready for upload. */
export async function renderProjectGlyphPng(choice: ProjectGlyphChoice): Promise<string> {
  const glyph = findProjectGlyph(choice.name);
  if (!glyph) throw new Error(`Unknown icon: ${choice.name}`);
  const size = GLYPH_TILE_PNG_SIZE;
  const image = new Image(size, size);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(glyphTileSvg(glyph, choice.color, size))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0, size, size);
  const png = Buffer.from(canvas.toDataURL("image/png").split(",")[1] ?? "", "base64");
  return Buffer.from(tagGlyphPng(png, choice)).toString("base64");
}
