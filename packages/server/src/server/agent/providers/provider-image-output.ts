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
// is idempotent: history replay reuses the existing temp file instead of leaking
// a fresh one on every load.
export function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): MaterializedProviderImage {
  const attachmentsDir = path.join(os.tmpdir(), PROVIDER_IMAGE_ATTACHMENT_DIR);
  fsSync.mkdirSync(attachmentsDir, { recursive: true });
  const normalized = normalizeImageData(image.mimeType ?? "image/png", image.data);
  const bytes = Buffer.from(normalized.data, "base64");
  const extension = getImageExtension(normalized.mimeType);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(attachmentsDir, `${hash}.${extension}`);
  fsSync.writeFileSync(filePath, bytes);
  return { path: filePath };
}

// Recognizes the markdown renderProviderImageOutputAsAssistantMarkdown emits for a materialized
// provider image: its source is a content-hashed file in the attachments dir. Matching the full
// <hash>.<ext> shape (not just a leading "![") keeps user-authored text from being mistaken for a
// provider image when it reaches the history-replay filter. The separator class allows one-or-more
// because on Windows the path uses "\\" and escapeMarkdownImageSource doubles each backslash.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}[/\\\\]+[0-9a-f]{64}\\.[a-z0-9]+\\)`,
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

function escapeMarkdownImageSource(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
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
