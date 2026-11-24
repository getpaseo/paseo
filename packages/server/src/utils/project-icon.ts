import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "fs/promises";
import { extname, join } from "path";

/**
 * Icon file patterns to search for, in priority order.
 * Patterns starting with '*' are glob patterns (e.g., icon-*.png).
 *
 * SVG and PNG outrank ICO across all known names: every client renders them
 * and they scale better. ICO is the final fallback because native clients
 * cannot decode containers whose frames use the legacy bitmap format.
 */
export const ICON_PATTERNS = [
  "favicon.svg",
  "favicon.png",
  "favicon-*.svg",
  "favicon-*.png",
  "favico.svg",
  "favico.png",
  "icon.svg",
  "icon.png",
  "app-icon.svg",
  "app-icon.png",
  "apple-touch-icon.png",
  "apple-touch-icon-*.png",
  "icon-*.png",
  "android-chrome-*.png",
  "safari-pinned-tab.svg",
  "mstile-*.png",
  "logo.svg",
  "logo.png",
  "favicon.ico",
  "favico.ico",
];

/**
 * Directories or directory paths to search first (in priority order).
 */
export const PRIORITY_DIRS = ["public", "static", "priv/static", "assets", "images", "img"];

/**
 * Monorepo package directory patterns to scan (e.g., packages/app, apps/web).
 */
export const MONOREPO_PACKAGE_DIRS = ["packages", "apps"];

/**
 * Directories to ignore during search.
 */
export const IGNORED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  "vendor",
  "src",
  "lib",
  "test",
  "tests",
  "__tests__",
];

export interface ProjectIcon {
  data: string;
  mimeType: string;
}

const MAX_ICON_SIZE = 32 * 1024; // 32KB max

export interface ImageDimensions {
  width: number;
  height: number;
}

function getPngDimensions(buffer: Buffer): ImageDimensions | null {
  // PNG header: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  // Width and height are at bytes 16-19 and 20-23 (big endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function getJpegDimensions(buffer: Buffer): ImageDimensions | null {
  // JPEG starts with FF D8 FF
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // SOF0-SOF2 markers contain dimensions
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    // Skip to next marker
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return null;
}

function getGifDimensions(buffer: Buffer): ImageDimensions | null {
  // GIF header: GIF87a or GIF89a
  if (buffer.length < 10) return null;
  if (buffer[0] !== 0x47 || buffer[1] !== 0x49 || buffer[2] !== 0x46) return null;
  // Width and height at bytes 6-7 and 8-9 (little endian)
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { width, height };
}

function getWebpDimensions(buffer: Buffer): ImageDimensions | null {
  // WEBP: RIFF....WEBP
  if (buffer.length < 30) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8 ") {
    // Lossy format - dimensions at offset 26-27 and 28-29
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height };
  } else if (chunkType === "VP8L") {
    // Lossless format
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

export function getImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
  switch (mimeType) {
    case "image/png":
      return getPngDimensions(buffer);
    case "image/jpeg":
      return getJpegDimensions(buffer);
    case "image/gif":
      return getGifDimensions(buffer);
    case "image/webp":
      return getWebpDimensions(buffer);
    case "image/x-icon":
      // ICO files are typically square, trust them
      return { width: 1, height: 1 };
    case "image/svg+xml":
      // SVG can be any aspect ratio but icons are typically square, trust them
      return { width: 1, height: 1 };
    default:
      return null;
  }
}

function isSquareImage(buffer: Buffer, mimeType: string): boolean {
  const dimensions = getImageDimensions(buffer, mimeType);
  if (!dimensions) return false;
  return dimensions.width === dimensions.height;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect the mime type from the file's magic bytes. Extensions lie: a large
 * share of real-world favicon.ico files are PNG data renamed, which browsers
 * render regardless — but native clients key off the reported mime type, so
 * mislabelling them image/x-icon needlessly drops the icon there.
 */
function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1 &&
    buffer.readUInt16LE(4) > 0
  ) {
    return "image/x-icon";
  }
  return null;
}

/**
 * ICO is a container; modern favicons usually carry a PNG-encoded frame for the
 * larger sizes. Native <Image> can't decode ICO but decodes PNG fine, so when a
 * PNG frame exists, serve the largest one as image/png instead of the container.
 */
export function extractIcoPngFrame(buffer: Buffer): Buffer | null {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return null;
  }
  const frameCount = buffer.readUInt16LE(4);
  let best: Buffer | null = null;
  let bestWidth = -1;
  for (let index = 0; index < frameCount; index += 1) {
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > buffer.length) {
      break;
    }
    // Directory entry: width(1) height(1) colors(1) reserved(1) planes(2)
    // bpp(2) dataSize(4 LE) dataOffset(4 LE). Width byte 0 means 256.
    const width = buffer[entryOffset] === 0 ? 256 : (buffer[entryOffset] ?? 0);
    const dataSize = buffer.readUInt32LE(entryOffset + 8);
    const dataOffset = buffer.readUInt32LE(entryOffset + 12);
    if (dataOffset + dataSize > buffer.length) {
      continue;
    }
    const frame = buffer.subarray(dataOffset, dataOffset + dataSize);
    if (frame.length >= 8 && frame.subarray(0, 8).equals(PNG_SIGNATURE) && width > bestWidth) {
      best = frame;
      bestWidth = width;
    }
  }
  return best;
}

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

const iconMatchers = ICON_PATTERNS.map((pattern) =>
  pattern.includes("*")
    ? new RegExp("^" + pattern.replaceAll(".", "\\.").replaceAll("*", ".*") + "$")
    : pattern,
);
const ignoredDirectories = new Set(IGNORED_DIRS);

async function readDirectory(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function firstIcon(dir: string, entries: Dirent[]): Promise<string | null> {
  for (const pattern of iconMatchers) {
    for (const entry of entries) {
      if (typeof pattern === "string" ? entry.name !== pattern : !pattern.test(entry.name))
        continue;
      const candidate = join(dir, entry.name);
      if (entry.isFile()) return candidate;
      if (entry.isSymbolicLink() && (await stat(candidate).catch(() => null))?.isFile())
        return candidate;
    }
  }
  return null;
}

function mayBeDirectory(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

async function searchDirectory(dir: string, depth: number): Promise<string | null> {
  if (depth < 0) return null;
  const entries = await readDirectory(dir);
  if (!entries) return null;
  const icon = await firstIcon(dir, entries);
  if (icon || depth === 0) return icon;
  const matches = await Promise.all(
    entries
      .filter((entry) => mayBeDirectory(entry) && !ignoredDirectories.has(entry.name))
      .map((entry) => searchDirectory(join(dir, entry.name), depth - 1)),
  );
  return matches.find(Boolean) ?? null;
}

async function searchPriorityDirs(
  dir: string,
  entries: Dirent[] | null,
  depth: number,
): Promise<string | null> {
  const names =
    entries && new Set(entries.filter(mayBeDirectory).map((entry) => entry.name.toLowerCase()));
  const matches = await Promise.all(
    PRIORITY_DIRS.filter((priority) => !names || names.has(priority.split("/")[0])).map(
      (priority) => searchDirectory(join(dir, priority), depth),
    ),
  );
  return matches.find(Boolean) ?? null;
}

export async function findProjectIcon(projectDir: string, maxDepth = 3): Promise<string | null> {
  const entries = await readDirectory(projectDir);
  const priority = await searchPriorityDirs(projectDir, entries, maxDepth - 1);
  if (priority) return priority;
  for (const name of MONOREPO_PACKAGE_DIRS) {
    if (
      entries &&
      !entries.some((entry) => entry.name.toLowerCase() === name && mayBeDirectory(entry))
    )
      continue;
    const directory = join(projectDir, name);
    const packages = ((await readDirectory(directory)) ?? []).filter(mayBeDirectory);
    const matches = await Promise.all(
      packages.map(async (entry) => {
        const pkg = join(directory, entry.name);
        const children = await readDirectory(pkg);
        return (
          (await searchPriorityDirs(pkg, children, maxDepth - 1)) ?? firstIcon(pkg, children ?? [])
        );
      }),
    );
    const icon = matches.find(Boolean);
    if (icon) return icon;
  }
  return firstIcon(projectDir, entries ?? []);
}

/**
 * Find and read a project icon/favicon, returning it as base64.
 * Only returns square icons smaller than MAX_ICON_SIZE (32KB).
 *
 * @param projectDir - The root directory of the project to search
 * @returns The icon data with mime type, or null if not found
 */
export async function getProjectIcon(projectDir: string): Promise<ProjectIcon | null> {
  const iconPath = await findProjectIcon(projectDir);
  if (!iconPath) {
    return null;
  }

  try {
    const stats = await stat(iconPath);
    if (stats.size > MAX_ICON_SIZE) {
      return null;
    }

    const fileBuffer = await readFile(iconPath);
    let mimeType = sniffMimeType(fileBuffer) ?? getMimeType(iconPath);
    let buffer: Buffer = fileBuffer;
    if (mimeType === "image/x-icon") {
      const pngFrame = extractIcoPngFrame(fileBuffer);
      if (pngFrame) {
        buffer = pngFrame;
        mimeType = "image/png";
      }
    }

    // Only return square images
    if (!isSquareImage(buffer, mimeType)) {
      return null;
    }

    const data = buffer.toString("base64");
    return { data, mimeType };
  } catch {
    return null;
  }
}
