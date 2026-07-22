import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../server/atomic-file.js";
import type { ProjectIcon } from "./project-icon.js";

const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const ICON_TOO_LARGE_ERROR = "Icon must be 512 KB or smaller";
const DOWNLOAD_TIMEOUT_MS = 10_000;

function cachePath(paseoHome: string, projectId: string): string {
  const key = createHash("sha256").update(projectId).digest("hex");
  return join(paseoHome, "projects", "icons", `${key}.bin`);
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function dimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === "image/x-icon" && buffer.length >= 22) {
    const width = buffer[6] === 0 ? 256 : (buffer[6] ?? 0);
    const height = buffer[7] === 0 ? 256 : (buffer[7] ?? 0);
    return { width, height };
  }
  if (mimeType === "image/webp") return webpDimensions(buffer);
  if (mimeType === "image/jpeg") return jpegDimensions(buffer);
  return null;
}

function detectMimeType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header = buffer.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1 &&
    buffer.readUInt16LE(4) > 0
  ) {
    return "image/x-icon";
  }
  return null;
}

function validateIcon(buffer: Buffer): ProjectIcon {
  if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES) {
    throw new Error(ICON_TOO_LARGE_ERROR);
  }
  const mimeType = detectMimeType(buffer);
  if (!mimeType) throw new Error("Unsupported or invalid icon file");
  const size = dimensions(buffer, mimeType);
  if (!size || size.width <= 0 || size.width !== size.height || size.width > 1024) {
    throw new Error("Icon must be a square image up to 1024×1024");
  }
  return { data: buffer.toString("base64"), mimeType };
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  truncate: boolean = false,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(ICON_TOO_LARGE_ERROR);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= maxBytes) return buffer;
    if (truncate) return buffer.subarray(0, maxBytes);
    throw new Error(ICON_TOO_LARGE_ERROR);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (truncate && remaining > 0) chunks.push(value.subarray(0, remaining));
      await reader.cancel();
      if (truncate) return Buffer.concat(chunks, maxBytes);
      throw new Error(ICON_TOO_LARGE_ERROR);
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function parseTagAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() || null;
}

function faviconCandidates(html: string, pageUrl: string): URL[] {
  const candidates: URL[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = parseTagAttribute(tag, "rel")?.toLowerCase() ?? "";
    const href = parseTagAttribute(tag, "href");
    const type = parseTagAttribute(tag, "type")?.toLowerCase() ?? "";
    if (!href || !rel.includes("icon") || type.includes("svg") || href.endsWith(".svg")) continue;
    try {
      candidates.push(new URL(href, pageUrl));
    } catch {
      // Ignore malformed icon links and try the conventional fallback.
    }
  }
  candidates.push(new URL("/favicon.ico", pageUrl));
  return candidates;
}

function parseHttpUrl(urlValue: string): URL {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("Enter a valid website or favicon URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("URL must use HTTP or HTTPS without credentials");
  }
  return url;
}

async function fetchUrl(url: URL): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response;
}

export async function downloadProjectFavicon(urlValue: string): Promise<Buffer> {
  const response = await fetchUrl(parseHttpUrl(urlValue));
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) {
    return readResponseBytes(response, MAX_ICON_BYTES);
  }

  const html = (await readResponseBytes(response, MAX_HTML_BYTES, true)).toString("utf8");
  let lastError: unknown = new Error("Website does not expose a supported favicon");
  for (const candidate of faviconCandidates(html, response.url).slice(0, 8)) {
    try {
      const buffer = await readResponseBytes(await fetchUrl(candidate), MAX_ICON_BYTES);
      validateIcon(buffer);
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function cacheProjectFavicon(input: {
  paseoHome: string;
  projectId: string;
  url: string;
}): Promise<ProjectIcon> {
  const buffer = await downloadProjectFavicon(input.url);
  const icon = validateIcon(buffer);
  await writeFileAtomic(cachePath(input.paseoHome, input.projectId), buffer);
  return icon;
}

export async function readCachedProjectFavicon(input: {
  paseoHome: string;
  projectId: string;
}): Promise<ProjectIcon | null> {
  try {
    return validateIcon(await readFile(cachePath(input.paseoHome, input.projectId)));
  } catch {
    return null;
  }
}
