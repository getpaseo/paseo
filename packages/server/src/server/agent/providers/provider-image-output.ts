import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import path from "node:path";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { resolvePaseoHome } from "../../paseo-home.js";

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

// The directory basename stays "paseo-attachments" because PROVIDER_IMAGE_MARKDOWN
// below matches on it, and history written by older builds used
// mkdtemp(os.tmpdir(), "paseo-attachments-") — the optional "-<suffix>" group in
// that regex is what lets one pattern match both shapes.
const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const PRIVATE_ATTACHMENT_DIR_MODE = 0o700;
const MATERIALIZED_IMAGE_FILE_MODE = 0o600;
// Materialized images used to live in os.tmpdir(), which the OS may reap (macOS
// clears /var/folders after ~3 days). That silently orphaned every image in any
// transcript older than the reap window: the markdown still pointed at a path
// whose bytes were gone, and nothing could re-create them.
//
// Nothing deletes these now, deliberately. An age-based sweep here would only
// move the same bug to a longer fuse — mtime cannot distinguish an image a
// transcript still references from an abandoned one, and reading a transcript
// does not touch the file. It would also be a regression on hosts whose temp
// dir is not reaped on a schedule, where these images currently survive
// indefinitely. Bounding this directory needs to be reference-aware, against
// the agent timelines that point into it.
//
// Growth is bounded in practice by content addressing: filenames are a hash of
// the bytes, so re-emitting or replaying an image reuses its existing file.

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

  const dir = path.join(resolvePaseoHome(), PROVIDER_IMAGE_ATTACHMENT_DIR);
  fsSync.mkdirSync(dir, { recursive: true, mode: PRIVATE_ATTACHMENT_DIR_MODE });
  fsSync.chmodSync(dir, PRIVATE_ATTACHMENT_DIR_MODE);
  materializedImageAttachmentDir = dir;
  return dir;
}

/** Test-only hook: the resolved directory is process-scoped. */
export function __resetMaterializedImageAttachmentDirForTests(): void {
  materializedImageAttachmentDir = null;
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

// Filenames are a content hash of the bytes, and the directory is now stable
// across daemon restarts, so re-materializing the same image reuses the existing
// file instead of leaking a fresh one for repeated image blocks or history
// replay. Under the old per-process temp directory this deduplication only held
// within a single daemon process — which is also why this directory does not
// grow per render, only per distinct image.
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
