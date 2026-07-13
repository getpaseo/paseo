import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
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

let materializedImageAttachmentDir: string | null = null;

function canReuseMaterializedImageAttachmentDir(dir: string): boolean {
  try {
    const stats = fsSync.lstatSync(dir);
    if (!stats.isDirectory()) {
      return false;
    }
    fsSync.chmodSync(dir, PRIVATE_ATTACHMENT_DIR_MODE);
    return true;
  } catch {
    return false;
  }
}

function getMaterializedImageAttachmentDir(): string {
  if (
    materializedImageAttachmentDir &&
    canReuseMaterializedImageAttachmentDir(materializedImageAttachmentDir)
  ) {
    return materializedImageAttachmentDir;
  }

  materializedImageAttachmentDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX),
  );
  fsSync.chmodSync(materializedImageAttachmentDir, PRIVATE_ATTACHMENT_DIR_MODE);
  return materializedImageAttachmentDir;
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

function normalizeImageData(mimeType: string, data: string): { mimeType: string; data: string } {
  if (data.startsWith("data:")) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }
  return { mimeType, data };
}

// Filenames are a content hash of the bytes so re-materializing the same image
// within a process reuses the existing temp file instead of leaking a fresh one
// for repeated image blocks or history replay.
export function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): MaterializedProviderImage {
  const attachmentsDir = getMaterializedImageAttachmentDir();
  const normalized = normalizeImageData(image.mimeType ?? "image/png", image.data);
  const bytes = Buffer.from(normalized.data, "base64");
  const extension = getImageExtension(normalized.mimeType);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(attachmentsDir, `${hash}.${extension}`);
  fsSync.writeFileSync(filePath, bytes, { mode: MATERIALIZED_IMAGE_FILE_MODE });
  fsSync.chmodSync(filePath, MATERIALIZED_IMAGE_FILE_MODE);
  return { path: filePath };
}

// Recognizes markdown rendered for a materialized provider image: its source is a content-hashed
// file in the attachments dir. Matching the full <hash>.<ext> shape (not just a leading "![")
// keeps user-authored text from being mistaken for a provider image during history replay. The
// separator still accepts old doubled-backslash Windows history; new Windows output uses file URIs.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`,
);

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN.test(text);
}

interface RenderProviderImageOutputOptions {
  materialize?: (image: { data: string; mimeType: string | null }) => MaterializedProviderImage;
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

function markdownImageSource(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return `file:///${value.replace(/\\/g, "/")}`;
  }
  return value;
}

function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export function renderProviderImageOutputAsAssistantMarkdown(
  image: ProviderImageOutput,
  options: RenderProviderImageOutputOptions = {},
): AgentTimelineItem | null {
  const source = nonEmptyString(image.path) ?? nonEmptyString(image.url);
  if (source && !isDataImageSource(source)) {
    const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
    return {
      type: "assistant_message",
      text: `![${altText}](${escapeMarkdownImageSource(source)})`,
    };
  }

  const data = nonEmptyString(image.data) ?? (source && isDataImageSource(source) ? source : null);
  if (!data) {
    return null;
  }

  let materialized: MaterializedProviderImage | null = null;
  try {
    materialized = options.materialize
      ? options.materialize({
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
    text: `![${altText}](${escapeMarkdownImageSource(materialized.path)})`,
  };
}
