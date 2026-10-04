import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentTimelineImage } from "../agent-sdk-types.js";
import { materializeProviderImage } from "./provider-image-output.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
};

function resolveMimeType(value: unknown, source: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof source !== "string") return undefined;
  return (
    /^data:([^;]+);base64,/.exec(source)?.[1] ??
    MIME_BY_EXTENSION[path.extname(source).toLowerCase()]
  );
}

// Only top-level image blocks belong to the user's message. Tool-result images are
// mapped separately, and must not become user attachments during history replay.
export function userMessageImages(content: unknown): AgentTimelineImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = record(value);
    const source = record(block.source);
    const local = block.type === "local_image" || block.type === "localImage";
    const file = block.type === "file";
    if (!local && !file && block.type !== "image") return [];
    const url = block.url ?? block.uri ?? source.url;
    const originalPath = local ? block.path : url;
    const rawMime = block.mimeType ?? block.mime ?? source.media_type;
    const mimeType = resolveMimeType(rawMime, originalPath);
    if (file && !mimeType?.startsWith("image/")) return [];
    const data = block.data ?? source.data;
    const resolvedSource = resolveSource(originalPath, data, mimeType ?? "image/png");
    if (!resolvedSource) return [];
    return [
      {
        id: createHash("sha256").update(resolvedSource).digest("hex"),
        source: resolvedSource,
        mimeType: mimeType ?? "image/png",
      },
    ];
  });
}

function resolveSource(source: unknown, data: unknown, mimeType: string): string | undefined {
  if (typeof data === "string") return materializeProviderImage({ data, mimeType }).path;
  if (typeof source !== "string") return undefined;
  if (source.startsWith("data:image/"))
    return materializeProviderImage({ data: source, mimeType }).path;
  return source;
}
