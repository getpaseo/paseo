import type { ToolCallImage } from "../../agent-sdk-types.js";

export interface ToolResultParts {
  text: string;
  images: ToolCallImage[];
}

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface TextBlock {
  type: "text";
  text: string;
}

interface Base64ImageSource {
  type: "base64";
  media_type: string;
  data: string;
}

interface ImageBlock {
  type: "image";
  source: Base64ImageSource;
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isBase64ImageBlock(value: unknown): value is ImageBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown; source?: unknown };
  if (block.type !== "image") return false;
  if (!block.source || typeof block.source !== "object") return false;
  const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown };
  return (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string" &&
    source.data.length > 0
  );
}

function normalizeForDeterministicString(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "[function]";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForDeterministicString(entry, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeForDeterministicString(record[key], seen);
    }
    seen.delete(value);
    return normalized;
  }
  return "[unsupported]";
}

function deterministicFallback(value: unknown): string {
  try {
    const normalized = normalizeForDeterministicString(value, new WeakSet<object>());
    return JSON.stringify(normalized);
  } catch {
    return "[unserializable]";
  }
}

export function extractToolResultParts(content: unknown): ToolResultParts {
  if (typeof content === "undefined") {
    return { text: "", images: [] };
  }
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: deterministicFallback(content), images: [] };
  }

  let text = "";
  const images: ToolCallImage[] = [];
  const unknownBlocks: unknown[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      text += block.text;
      continue;
    }
    if (isBase64ImageBlock(block) && SUPPORTED_MIME_TYPES.has(block.source.media_type)) {
      images.push({ data: block.source.data, mimeType: block.source.media_type });
      continue;
    }
    // Anything we don't recognize (e.g., document blocks, URL-source images,
    // future block types) is preserved as a JSON fallback so its content is
    // not silently lost.
    unknownBlocks.push(block);
  }
  if (unknownBlocks.length > 0) {
    const serialized = deterministicFallback(unknownBlocks);
    text = text.length > 0 ? `${text}\n${serialized}` : serialized;
  }
  return { text, images };
}
