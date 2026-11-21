import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

import type { AgentTimelineItem } from "../agent-sdk-types.js";

export interface ProviderImageOutput {
  path?: string | null;
  url?: string | null;
  data?: string | null;
  mimeType?: string | null;
  altText?: string | null;
}

export interface MaterializedProviderImage {
  path: string;
}

const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX = `${PROVIDER_IMAGE_ATTACHMENT_DIR}-`;
const PRIVATE_ATTACHMENT_DIR_MODE = 0o700;
const MATERIALIZED_IMAGE_FILE_MODE = 0o600;

let attachmentDirectory: Promise<string> | undefined;
const pendingWrites = new Map<string, Promise<MaterializedProviderImage>>();

function getMaterializedImageAttachmentDir(): Promise<string> {
  attachmentDirectory ??= createAttachmentDirectory().catch((error) => {
    attachmentDirectory = undefined;
    throw error;
  });
  return attachmentDirectory;
}

async function createAttachmentDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX));
  await fs.chmod(dir, PRIVATE_ATTACHMENT_DIR_MODE);
  return dir;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

// 128 MiB admits the measured 64 MiB fixture with headroom while bounding disk
// and decoding per image. This is materialization admission, not a wire schema limit.
export const MAX_PROVIDER_IMAGE_BYTES = 128 * 1024 * 1024;
const BASE64_CHUNK_CHARACTERS = 1024 * 1024; // Multiple of four; decode units stay aligned.
const DECODE_SLICE_MS = 10;
let decodeBudgetMs = DECODE_SLICE_MS;
let pendingDecodeYield: Promise<void> | undefined;

async function refillDecodeBudget(): Promise<void> {
  await setImmediate();
  decodeBudgetMs = DECODE_SLICE_MS;
  pendingDecodeYield = undefined;
}

export async function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): Promise<MaterializedProviderImage> {
  const maxEncodedCharacters = Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4;
  // Check length before inspecting/copying the payload, including a bounded data URI header.
  if (image.data.length > maxEncodedCharacters + 256) {
    throw new Error(`Image attachment exceeds ${MAX_PROVIDER_IMAGE_BYTES} bytes`);
  }
  let data = image.data;
  let mimeType = image.mimeType ?? "image/png";
  if (data.startsWith("data:")) {
    const separator = data.indexOf(";base64,");
    if (separator >= 0 && separator < 256) {
      mimeType = data.slice(5, separator);
      data = data.slice(separator + 8);
    }
  }
  if (data.length > maxEncodedCharacters) {
    throw new Error(`Image attachment exceeds ${MAX_PROVIDER_IMAGE_BYTES} bytes`);
  }
  const hash = createHash("sha256");
  for await (const bytes of decodeImage(data)) hash.update(bytes);
  const filename = `${hash.digest("hex")}.${getImageExtension(mimeType)}`;
  const directory = getMaterializedImageAttachmentDir();
  const dir = await directory;
  try {
    return await materializeInDirectory(dir, filename, data);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    // Other requests may have already replaced the directory after the same deletion.
    if (attachmentDirectory === directory) attachmentDirectory = undefined;
    const replacement = await getMaterializedImageAttachmentDir();
    return materializeInDirectory(replacement, filename, data);
  }
}

function materializeInDirectory(
  dir: string,
  filename: string,
  data: string,
): Promise<MaterializedProviderImage> {
  const filePath = path.join(dir, filename);
  const pending = pendingWrites.get(filePath);
  if (pending) return pending;

  const write = publishImage(dir, filePath, data).finally(() => {
    pendingWrites.delete(filePath);
  });
  pendingWrites.set(filePath, write);
  return write;
}

async function publishImage(
  dir: string,
  filePath: string,
  data: string,
): Promise<MaterializedProviderImage> {
  const [directory, existing] = await Promise.allSettled([fs.lstat(dir), fs.stat(filePath)]);
  if (directory.status === "rejected") throw directory.reason;
  const stats = directory.value;
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (
    !stats.isDirectory() ||
    (uid !== undefined && (stats.uid !== uid || (stats.mode & 0o077) !== 0))
  ) {
    throw Object.assign(new Error("Private image attachment directory is unavailable"), {
      code: "ENOENT",
    });
  }
  if (existing.status === "fulfilled") return { path: filePath };
  if (!isMissingPath(existing.reason)) throw existing.reason;

  const stagingPath = path.join(dir, `.pending-${randomUUID()}`);
  const file = await fs.open(stagingPath, "wx", MATERIALIZED_IMAGE_FILE_MODE);
  try {
    try {
      // Restore owner permissions if the umask masked them at open.
      await file.chmod(MATERIALIZED_IMAGE_FILE_MODE);
      // Decode again only for new content, retaining one chunk at a time.
      for await (const bytes of decodeImage(data)) await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await fs.rename(stagingPath, filePath);
    return { path: filePath };
  } catch (error) {
    await fs.unlink(stagingPath).catch((cleanupError) => {
      if (!isMissingPath(cleanupError)) throw cleanupError;
    });
    throw error;
  }
}

async function* decodeImage(data: string): AsyncGenerator<Buffer> {
  let carry = "";
  let decodedBytes = 0;
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_CHARACTERS) {
    let pause = pendingDecodeYield;
    while (pause) {
      await pause;
      pause = pendingDecodeYield;
    }
    // Charge synchronous work across decoders. File I/O and idle time leave the budget intact.
    const startedAt = performance.now();
    // Buffer.from ignores non-base64 characters. Carry incomplete quartets so
    // line-wrapped payloads decode identically across chunk boundaries.
    const chunk =
      carry +
      data.slice(offset, offset + BASE64_CHUNK_CHARACTERS).replace(/[^A-Za-z0-9+/_=-]/g, "");
    const finalChunk = offset + BASE64_CHUNK_CHARACTERS >= data.length || chunk.includes("=");
    const end = finalChunk ? chunk.length : chunk.length - (chunk.length % 4);
    const bytes = Buffer.from(chunk.slice(0, end), "base64");
    decodeBudgetMs -= performance.now() - startedAt;
    if (decodeBudgetMs <= 0) pendingDecodeYield = refillDecodeBudget();
    carry = chunk.slice(end);
    decodedBytes += bytes.length;
    if (decodedBytes > MAX_PROVIDER_IMAGE_BYTES)
      throw new Error("Image attachment exceeds size limit");
    yield bytes;
    if (finalChunk) break;
  }
}

// Recognizes markdown rendered for a materialized provider image: its source is a content-hashed
// file in the attachments dir. Matching the full <hash>.<ext> shape (not just a leading "![")
// keeps user-authored text from being mistaken for a provider image during history replay. The
// separator still accepts old doubled-backslash Windows history; new Windows output uses file URIs.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`,
);

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN.test(text.trimStart());
}

interface RenderProviderImageOutputOptions {
  materialize?: (image: {
    data: string;
    mimeType: string | null;
  }) => Promise<MaterializedProviderImage>;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDataImageSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith("data:image/");
}

function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function windowsFileUri(value: string): string | null {
  const isWindowsNetworkPath = value.startsWith("\\\\");
  let normalizedPath = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalizedPath)) {
    normalizedPath = `//${normalizedPath.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(4);
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    return `file:///${drive}${encodeFilePath(normalizedPath.slice(2))}`;
  }
  if (isWindowsNetworkPath && normalizedPath.startsWith("//")) {
    return `file:${encodeFilePath(normalizedPath)}`;
  }
  return null;
}

function markdownImageSource(value: string): string {
  const windowsUri = windowsFileUri(value);
  if (windowsUri) {
    return windowsUri;
  }
  if (value.startsWith("/")) {
    return `file://${encodeFilePath(value)}`;
  }
  return value;
}

function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export async function renderProviderImageOutputAsAssistantMarkdown(
  image: ProviderImageOutput,
  options: RenderProviderImageOutputOptions = {},
): Promise<AgentTimelineItem | null> {
  const source = nonEmptyString(image.path) ?? nonEmptyString(image.url);
  if (source && !isDataImageSource(source)) {
    const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
    return {
      type: "assistant_message",
      // Image outputs remain standalone paragraphs when adjacent assistant chunks merge.
      text: `\n\n![${altText}](${escapeMarkdownImageSource(source)})\n\n`,
    };
  }

  const data = nonEmptyString(image.data) ?? (source && isDataImageSource(source) ? source : null);
  if (!data) {
    return null;
  }

  let materialized: MaterializedProviderImage | null = null;
  try {
    materialized = options.materialize
      ? await options.materialize({
          data,
          mimeType: nonEmptyString(image.mimeType),
        })
      : null;
  } catch {
    materialized = null;
  }
  if (!materialized?.path || isDataImageSource(materialized.path)) {
    return {
      type: "assistant_message",
      text: "Image output was omitted because it was not available as a file path or URL.",
    };
  }

  const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
  return {
    type: "assistant_message",
    text: `\n\n![${altText}](${escapeMarkdownImageSource(materialized.path)})\n\n`,
  };
}
