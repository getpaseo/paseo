import { Buffer } from "buffer";
import { RADIX_GLYPHS } from "@/projects/radix-glyphs";

/**
 * A project icon made of a Radix glyph on a colored tile, in place of the derived letter.
 *
 * The daemon stores raster images only (PNG, JPEG, GIF, WebP, ICO), so the tile is composed
 * here as SVG and flattened to a PNG before it goes through the same upload as a picked file.
 * Every client then shows it as an ordinary custom icon, including apps that predate this
 * picker. The PNG carries a small text chunk naming the glyph and color, so reopening the
 * picker can show what was chosen.
 */
export interface ProjectGlyphChoice {
  name: string;
  color: string;
}

export interface ProjectGlyph {
  name: string;
  /** Inside of a 15×15 icon, painted by an enclosing fill. */
  body: string;
}

/** Edge of the uploaded PNG. Sharp at the 40pt preview on a 2× display, and a few KB. */
export const GLYPH_TILE_PNG_SIZE = 256;
/**
 * Same corner as the letter tile (project-icon-view's RADIUS_RATIO). An uploaded icon is never
 * clipped by the app, so the rounding is baked in.
 */
const TILE_RADIUS_RATIO = 0.25;
/** Glyph edge against the tile: 9pt in the 16pt sidebar tile, close to the letter's weight. */
const GLYPH_RATIO = 0.5625;
const GLYPH_FOREGROUND = "#ffffff";
const PNG_TEXT_KEYWORD = "paseo-glyph";

/**
 * Glyphs that read as a project at a glance come first; the rest follow alphabetically.
 * Without this the grid opens on accessibility, align-* and arrow-*.
 */
const LEADING_GLYPHS = [
  "rocket",
  "code",
  "cube",
  "component-1",
  "layers",
  "stack",
  "lightning-bolt",
  "globe",
  "desktop",
  "mobile",
  "laptop",
  "gear",
  "home",
  "star",
  "heart",
  "target",
  "magic-wand",
  "mix",
  "dashboard",
  "bar-chart",
  "pie-chart",
  "backpack",
  "archive",
  "reader",
  "file-text",
  "chat-bubble",
  "envelope-closed",
  "person",
  "camera",
  "image",
  "video",
  "speaker-loud",
  "sun",
  "moon",
  "lock-closed",
  "tokens",
  "rows",
  "box",
  "github-logo",
  "figma-logo",
] as const;

let orderedGlyphs: ProjectGlyph[] | null = null;
let glyphsByName: Map<string, ProjectGlyph> | null = null;

export function listProjectGlyphs(): ProjectGlyph[] {
  if (orderedGlyphs) return orderedGlyphs;
  const all = RADIX_GLYPHS.map(([name, body]) => ({ name, body }));
  const lead = new Map<string, number>(LEADING_GLYPHS.map((name, index) => [name, index]));
  orderedGlyphs = [
    ...all.filter((glyph) => lead.has(glyph.name)).sort(byLeadIndex(lead)),
    ...all.filter((glyph) => !lead.has(glyph.name)),
  ];
  return orderedGlyphs;
}

function byLeadIndex(lead: Map<string, number>) {
  return (a: ProjectGlyph, b: ProjectGlyph) => (lead.get(a.name) ?? 0) - (lead.get(b.name) ?? 0);
}

export function findProjectGlyph(name: string): ProjectGlyph | null {
  glyphsByName ??= new Map(listProjectGlyphs().map((glyph) => [glyph.name, glyph]));
  return glyphsByName.get(name) ?? null;
}

/** Every word of the query has to appear in the glyph's name; separators are ignored. */
export function searchProjectGlyphs(query: string): ProjectGlyph[] {
  const words = query
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return listProjectGlyphs();
  return listProjectGlyphs().filter((glyph) => {
    const name = glyph.name.replace(/-/g, "");
    return words.every((word) => glyph.name.includes(word) || name.includes(word));
  });
}

/** One glyph at the icon's own 15×15 grid, painted with currentColor, for the picker. */
export function glyphSvg(glyph: ProjectGlyph): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" fill="none">' +
    `<g fill="currentColor">${glyph.body}</g></svg>`
  );
}

/** The whole tile, as it will look in the sidebar: rounded color square, white glyph. */
export function glyphTileSvg(
  glyph: ProjectGlyph,
  color: string,
  size: number = GLYPH_TILE_PNG_SIZE,
): string {
  const radius = round(size * TILE_RADIUS_RATIO);
  const edge = size * GLYPH_RATIO;
  const offset = round((size - edge) / 2);
  const scale = round(edge / 15);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" fill="none">` +
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${escapeAttribute(color)}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="${GLYPH_FOREGROUND}">` +
    `${glyph.body}</g></svg>`
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escapeAttribute(value: string): string {
  return value.replace(/[^#0-9a-zA-Z(),.% ]/g, "");
}

/** Text the PNG carries so the picker can reopen on the same glyph and color. */
export function encodeGlyphTag(choice: ProjectGlyphChoice): string {
  return `${choice.name} ${choice.color}`;
}

export function decodeGlyphTag(text: string): ProjectGlyphChoice | null {
  const match = /^([a-z0-9-]+) (#[0-9a-fA-F]{6})$/.exec(text.trim());
  if (!match || !findProjectGlyph(match[1])) return null;
  return { name: match[1], color: match[2].toLowerCase() };
}

/** The glyph a custom icon was made from, or null for any other image. */
export function readProjectGlyphChoice(dataUri: string | null): ProjectGlyphChoice | null {
  if (!dataUri) return null;
  const match = /^data:image\/png;base64,(.*)$/s.exec(dataUri);
  if (!match) return null;
  const text = readPngText(Buffer.from(match[1], "base64"), PNG_TEXT_KEYWORD);
  return text === null ? null : decodeGlyphTag(text);
}

/** Adds the glyph tag to a PNG the canvas produced. */
export function tagGlyphPng(png: Uint8Array, choice: ProjectGlyphChoice): Uint8Array {
  return insertPngText(png, PNG_TEXT_KEYWORD, encodeGlyphTag(choice));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

interface PngChunk {
  type: string;
  start: number;
  dataStart: number;
  length: number;
}

function* pngChunks(bytes: Uint8Array): Generator<PngChunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset + 12 + length > bytes.length) return;
    yield { type, start: offset, dataStart: offset + 8, length };
    offset += 12 + length;
  }
}

export function readPngText(bytes: Uint8Array, keyword: string): string | null {
  if (!isPng(bytes)) return null;
  for (const chunk of pngChunks(bytes)) {
    if (chunk.type !== "tEXt") continue;
    const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const separator = data.indexOf(0);
    if (separator < 0) continue;
    if (latin1(data.subarray(0, separator)) === keyword)
      return latin1(data.subarray(separator + 1));
  }
  return null;
}

/** Inserts a tEXt chunk right before IEND. Keyword and text are ASCII. */
export function insertPngText(bytes: Uint8Array, keyword: string, text: string): Uint8Array {
  if (!isPng(bytes)) throw new Error("Not a PNG");
  let iend: PngChunk | null = null;
  for (const chunk of pngChunks(bytes)) {
    if (chunk.type === "IEND") iend = chunk;
  }
  if (!iend) throw new Error("PNG has no IEND chunk");
  const data = new Uint8Array([...ascii(keyword), 0, ...ascii(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(ascii("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, iend.start), 0);
  out.set(chunk, iend.start);
  out.set(bytes.subarray(iend.start), iend.start + chunk.length);
  return out;
}

function ascii(value: string): number[] {
  return Array.from(value, (char) => char.charCodeAt(0) & 0x7f);
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
