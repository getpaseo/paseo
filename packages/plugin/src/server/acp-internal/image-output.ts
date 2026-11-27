import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface AcpImagePayload {
  path?: string | null;
  url?: string | null;
  data?: string | null;
  mimeType?: string | null;
  altText?: string | null;
}

const ATTACHMENT_DIR_PREFIX = "paseo-attachments-";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

let attachmentDirectory: Promise<string> | undefined;
const pendingWrites = new Map<string, Promise<string>>();

function getAttachmentDir(): Promise<string> {
  attachmentDirectory ??= createAttachmentDir().catch((error) => {
    attachmentDirectory = undefined;
    throw error;
  });
  return attachmentDirectory;
}

async function createAttachmentDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), ATTACHMENT_DIR_PREFIX));
  await fs.chmod(dir, PRIVATE_DIR_MODE);
  return dir;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function imageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
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

export function isLocalImageFilePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed || /^(https?:|data:|blob:)/i.test(trimmed)) return false;
  const ext = path.extname(trimmed).toLowerCase();
  return LOCAL_IMAGE_EXTENSIONS.has(ext);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDataImage(source: string): boolean {
  return source.trim().toLowerCase().startsWith("data:image/");
}

function escapeAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function windowsFileUri(value: string): string | null {
  const isUnc = value.startsWith("\\\\");
  let normalized = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalized)) {
    normalized = `//${normalized.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}${encodeFilePath(normalized.slice(2))}`;
  }
  if (isUnc && normalized.startsWith("//")) {
    return `file:${encodeFilePath(normalized)}`;
  }
  return null;
}

export function formatMarkdownImageSource(value: string): string {
  const win = windowsFileUri(value);
  if (win) return win;
  if (value.startsWith("/")) return `file://${encodeFilePath(value)}`;
  return value;
}

function escapeSource(value: string): string {
  return formatMarkdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

async function writeAtomicImage(dir: string, filePath: string, bytes: Buffer): Promise<string> {
  const pending = pendingWrites.get(filePath);
  if (pending) return pending;

  const task = (async () => {
    try {
      await fs.stat(filePath);
      return filePath;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    const stagingPath = path.join(dir, `.pending-${randomUUID()}`);
    const handle = await fs.open(stagingPath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(stagingPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await fs.rename(stagingPath, filePath);
    return filePath;
  })().finally(() => {
    pendingWrites.delete(filePath);
  });

  pendingWrites.set(filePath, task);
  return task;
}

export async function materializeAcpImage(image: {
  data: string;
  mimeType: string | null;
}): Promise<string> {
  const maxEncoded = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (image.data.length > maxEncoded + 256) {
    throw new Error(`Image output exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  let raw = image.data;
  let mimeType = image.mimeType ?? "image/png";
  if (raw.startsWith("data:")) {
    const separator = raw.indexOf(";base64,");
    if (separator >= 0 && separator < 256) {
      mimeType = raw.slice(5, separator);
      raw = raw.slice(separator + 8);
    }
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image output exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const filename = `${createHash("sha256").update(bytes).digest("hex")}.${imageExtension(mimeType)}`;
  const dirPromise = getAttachmentDir();
  const dir = await dirPromise;
  try {
    return await writeAtomicImage(dir, path.join(dir, filename), bytes);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    if (attachmentDirectory === dirPromise) attachmentDirectory = undefined;
    const replacement = await getAttachmentDir();
    return await writeAtomicImage(replacement, path.join(replacement, filename), bytes);
  }
}

export async function renderAcpImageAsMarkdown(image: AcpImagePayload): Promise<string | null> {
  const direct = nonEmpty(image.path) ?? nonEmpty(image.url);
  if (direct && !isDataImage(direct)) {
    const alt = escapeAlt(nonEmpty(image.altText) ?? "Image");
    return `\n\n![${alt}](${escapeSource(direct)})\n\n`;
  }
  const data = nonEmpty(image.data) ?? (direct && isDataImage(direct) ? direct : null);
  if (!data) return null;
  let filePath: string | null = null;
  try {
    filePath = await materializeAcpImage({ data, mimeType: nonEmpty(image.mimeType) });
  } catch {
    filePath = null;
  }
  if (!filePath || isDataImage(filePath)) return null;
  const alt = escapeAlt(nonEmpty(image.altText) ?? "Image");
  return `\n\n![${alt}](${escapeSource(filePath)})\n\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractImageFromContentBlock(block: unknown): AcpImagePayload | null {
  const record = asRecord(block);
  if (!record) return null;
  if (record.type === "image") {
    const data = typeof record.data === "string" ? record.data : null;
    const uri = typeof record.uri === "string" ? record.uri : null;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : null;
    if (data || uri) return { data, url: uri, mimeType };
  }
  if (record.type === "resource") {
    const resource = asRecord(record.resource);
    const mimeType = typeof resource?.mimeType === "string" ? resource.mimeType : null;
    if (resource && mimeType?.toLowerCase().startsWith("image/")) {
      const blob = typeof resource.blob === "string" ? resource.blob : null;
      const uri = typeof resource.uri === "string" ? resource.uri : null;
      if (blob) return { data: blob, mimeType };
      if (uri) return { url: uri, mimeType };
    }
  }
  return null;
}

export function extractToolCallContentImages(content: JsonValue | undefined): AcpImagePayload[] {
  if (!Array.isArray(content)) return [];
  const images: AcpImagePayload[] = [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (!record) continue;
    const inner = record.type === "content" ? record.content : record;
    const image = extractImageFromContentBlock(inner);
    if (image) images.push(image);
  }
  return images;
}

export function stripToolCallContentImages(content: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const cleaned = content.map((entry): JsonValue => {
    const record = asRecord(entry);
    if (!record) return entry;
    const inner = record.type === "content" ? record.content : record;
    if (!extractImageFromContentBlock(inner)) return entry;
    changed = true;
    return record.type === "content"
      ? { type: "content", content: { type: "text", text: "[image]" } }
      : { type: "text", text: "[image]" };
  });
  return changed ? cleaned : content;
}
