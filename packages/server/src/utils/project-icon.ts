import { readdir, readFile, stat } from "fs/promises";
import { extname, join } from "path";

/**
 * Icon file patterns to search for, in priority order.
 * Patterns starting with '*' are glob patterns (e.g., icon-*.png).
 *
 * Within each name, SVG and PNG outrank ICO: every client renders them (React
 * Native's <Image> cannot decode ICO at all) and they scale better. ICO is the
 * last resort for each name, not the first.
 */
export const ICON_PATTERNS = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "favico.svg",
  "favico.png",
  "favico.ico",
  "icon.svg",
  "icon.png",
  "app-icon.svg",
  "app-icon.png",
  "apple-touch-icon.png",
  "icon-*.png",
  "logo.svg",
  "logo.png",
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

function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    // Convert glob pattern to regex
    const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
    return new RegExp(`^${regexPattern}$`).test(filename);
  }
  return filename === pattern;
}

async function isExistingFile(fullPath: string): Promise<boolean> {
  try {
    const stats = await stat(fullPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function isExistingDirectory(fullPath: string): Promise<boolean> {
  try {
    const stats = await stat(fullPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findIconInDir(dir: string, patterns: string[]): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  // Collect candidate paths in priority order (pattern, then entry)
  const candidatePaths: string[] = [];
  for (const pattern of patterns) {
    for (const entry of entries) {
      if (matchesPattern(entry, pattern)) {
        candidatePaths.push(join(dir, entry));
      }
    }
  }

  const existsResults = await Promise.all(candidatePaths.map((p) => isExistingFile(p)));
  const foundIndex = existsResults.findIndex((exists) => exists);
  return foundIndex === -1 ? null : (candidatePaths[foundIndex] ?? null);
}

async function searchPriorityDirs(
  basePath: string,
  ignoredDirsSet: Set<string>,
  remainingDepth: number,
): Promise<string | null> {
  const priorityPaths = PRIORITY_DIRS.map((priorityDir) => join(basePath, priorityDir));
  const existenceResults = await Promise.all(
    priorityPaths.map((priorityPath) => isExistingDirectory(priorityPath)),
  );
  const searchResults = await Promise.all(
    priorityPaths.map((priorityPath, index) =>
      existenceResults[index]
        ? searchDirRecursively(priorityPath, ICON_PATTERNS, ignoredDirsSet, remainingDepth)
        : Promise.resolve(null),
    ),
  );
  return searchResults.find((result): result is string => result !== null) ?? null;
}

async function searchDirRecursively(
  dir: string,
  patterns: string[],
  ignoredDirs: Set<string>,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<string | null> {
  if (currentDepth > maxDepth) {
    return null;
  }

  // First check this directory for icons
  const found = await findIconInDir(dir, patterns);
  if (found) {
    return found;
  }

  // Then recurse into subdirectories
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const candidatePaths = entries
    .filter((entry) => !ignoredDirs.has(entry))
    .map((entry) => join(dir, entry));
  const isDirResults = await Promise.all(
    candidatePaths.map((fullPath) => isExistingDirectory(fullPath)),
  );
  const recursionResults = await Promise.all(
    candidatePaths.map((fullPath, index) =>
      isDirResults[index]
        ? searchDirRecursively(fullPath, patterns, ignoredDirs, maxDepth, currentDepth + 1)
        : Promise.resolve(null),
    ),
  );
  return recursionResults.find((result): result is string => result !== null) ?? null;
}

/**
 * Find a project icon/favicon in the given directory.
 * Searches priority directories first, then falls back to scanning the root.
 *
 * @param projectDir - The root directory of the project to search
 * @param maxDepth - Maximum depth to search (default: 3)
 * @returns The absolute path to the found icon, or null if not found
 */
export async function findProjectIcon(
  projectDir: string,
  maxDepth: number = 3,
): Promise<string | null> {
  const ignoredDirsSet = new Set(IGNORED_DIRS);

  // First search priority directories
  const priorityResult = await searchPriorityDirs(projectDir, ignoredDirsSet, maxDepth - 1);
  if (priorityResult) {
    return priorityResult;
  }

  // Then search monorepo package directories (packages/*, apps/*)
  const monoPaths = MONOREPO_PACKAGE_DIRS.map((monoDir) => join(projectDir, monoDir));
  const monoEntries = await Promise.all(
    monoPaths.map(async (monoPath): Promise<string[] | null> => {
      try {
        return await readdir(monoPath);
      } catch {
        return null;
      }
    }),
  );
  const monoResults = await Promise.all(
    monoPaths.map(async (monoPath, monoIdx): Promise<string | null> => {
      const packageEntries = monoEntries[monoIdx];
      if (!packageEntries) return null;
      const packagePaths = packageEntries.map((packageName) => join(monoPath, packageName));
      const isDirResults = await Promise.all(
        packagePaths.map((packagePath) => isExistingDirectory(packagePath)),
      );
      const packageResults = await Promise.all(
        packagePaths.map(async (packagePath, idx): Promise<string | null> => {
          if (!isDirResults[idx]) return null;
          const packagePriorityResult = await searchPriorityDirs(
            packagePath,
            ignoredDirsSet,
            maxDepth - 1,
          );
          if (packagePriorityResult) return packagePriorityResult;
          return await findIconInDir(packagePath, ICON_PATTERNS);
        }),
      );
      return packageResults.find((result): result is string => result !== null) ?? null;
    }),
  );
  const monoMatch = monoResults.find((result): result is string => result !== null);
  if (monoMatch) {
    return monoMatch;
  }

  // Then search root and any other non-priority directories
  const found = await findDirRecursively(projectDir);
  if (found) {
    return found;
  }

  return null;
}

async function findDirRecursively(
  dir: string,
  maxDepth: number = 2,
  currentDepth: number = 0,
): Promise<string | null> {
  const ignoredDirsSet = new Set(IGNORED_DIRS);
  const priorityDirsSet = new Set(PRIORITY_DIRS);

  if (currentDepth > maxDepth) {
    return null;
  }

  // Check root for icons
  const found = await findIconInDir(dir, ICON_PATTERNS);
  if (found) {
    return found;
  }

  // Don't recurse further from root - we already searched priority dirs
  if (currentDepth === 0) {
    return null;
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const candidatePaths = entries
    .filter((entry) => !ignoredDirsSet.has(entry) && !priorityDirsSet.has(entry))
    .map((entry) => join(dir, entry));
  const isDirResults = await Promise.all(
    candidatePaths.map((fullPath) => isExistingDirectory(fullPath)),
  );
  const recursionResults = await Promise.all(
    candidatePaths.map((fullPath, index) =>
      isDirResults[index]
        ? findDirRecursively(fullPath, maxDepth, currentDepth + 1)
        : Promise.resolve(null),
    ),
  );
  return recursionResults.find((result): result is string => result !== null) ?? null;
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
