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
export async function userMessageImages(content: unknown): Promise<AgentTimelineImage[]> {
  if (!Array.isArray(content)) return [];
  const images = await Promise.all(
    content.flatMap((value) => {
      const candidate = readUserImageCandidate(value);
      // A single image that cannot be written (full or unwritable temp storage) must not
      // reject the whole message: history replay would drop the text and sibling messages.
      return candidate ? [resolveUserImage(candidate).catch(() => undefined)] : [];
    }),
  );
  return images.filter((image) => image !== undefined);
}

interface UserImageCandidate {
  source: unknown;
  data: unknown;
  mimeType: string;
}

function readUserImageCandidate(value: unknown): UserImageCandidate | null {
  const block = record(value);
  const source = record(block.source);
  const local = block.type === "local_image" || block.type === "localImage";
  const file = block.type === "file";
  if (!local && !file && block.type !== "image") return null;
  const url = block.url ?? block.uri ?? source.url;
  const originalPath = local ? block.path : url;
  const rawMime = block.mimeType ?? block.mime ?? source.media_type;
  const mimeType = resolveMimeType(rawMime, originalPath);
  if (file && !mimeType?.startsWith("image/")) return null;
  return {
    source: originalPath,
    data: block.data ?? source.data,
    mimeType: mimeType ?? "image/png",
  };
}

async function resolveUserImage(
  candidate: UserImageCandidate,
): Promise<AgentTimelineImage | undefined> {
  const resolvedSource = await resolveSource(candidate.source, candidate.data, candidate.mimeType);
  if (!resolvedSource) return undefined;
  return {
    id: createHash("sha256").update(resolvedSource).digest("hex"),
    source: resolvedSource,
    mimeType: candidate.mimeType,
  };
}

async function resolveSource(
  source: unknown,
  data: unknown,
  mimeType: string,
): Promise<string | undefined> {
  if (typeof data === "string") return (await materializeProviderImage({ data, mimeType })).path;
  if (typeof source !== "string") return undefined;
  if (source.startsWith("data:image/"))
    return (await materializeProviderImage({ data: source, mimeType })).path;
  return source;
}
