import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { createImageSourceCacheKey } from "@/attachments/utils";

export interface AssistantImageContext {
  serverId?: string;
  workspaceRoot?: string;
}

export interface AssistantImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
}

const assistantImageMetadataCache = new Map<string, AssistantImageMetadata>();
const assistantImageParseCache = new Map<string, { sources: string[]; hasNonImageText: boolean }>();
const ASSISTANT_IMAGE_METADATA_CACHE_LIMIT = 500;
const ASSISTANT_IMAGE_PARSE_CACHE_LIMIT = 500;

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g;
export const ASSISTANT_IMAGE_DEFAULT_ASPECT_RATIO = 3 / 2;
const ASSISTANT_IMAGE_INSET = 8;
const ASSISTANT_IMAGE_MIN_HEIGHT = 160;
const ASSISTANT_IMAGE_BLOCK_GAP = 24;
const ASSISTANT_MESSAGE_BASE_HEIGHT = 96;
const ASSISTANT_MESSAGE_MIN_HEIGHT = 220;
const ASSISTANT_MESSAGE_IMAGE_ONLY_BASE_HEIGHT = 40;

function touchCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= limit) {
    return;
  }
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

function normalizeAssistantImageSourceToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner || null;
  }

  const titleMatch = /^(.*?)(?:\s+(['"]).*?\2)?$/.exec(trimmed);
  const source = titleMatch?.[1]?.trim() ?? trimmed;
  return source || null;
}

function parseAssistantImageMarkdown(markdown: string): {
  sources: string[];
  hasNonImageText: boolean;
} {
  const sources: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const normalized = normalizeAssistantImageSourceToken(match[1] ?? "");
    if (normalized) {
      sources.push(normalized);
    }
  }
  return {
    sources,
    hasNonImageText: markdown.replace(MARKDOWN_IMAGE_PATTERN, "").trim().length > 0,
  };
}

function getAssistantImageMetadataKey(
  input: AssistantImageContext & { source: string },
): string | null {
  const resolution = resolveAssistantImageSource({
    source: input.source,
    workspaceRoot: input.workspaceRoot,
  });
  if (!resolution) {
    return null;
  }
  if (resolution.kind === "direct") {
    return `direct:${createImageSourceCacheKey(resolution.uri)}`;
  }
  // A file path identifies an image only within its daemon and workspace.
  // Callers without that context must use the default aspect ratio.
  if (!input.serverId) {
    return null;
  }
  return JSON.stringify(["file", input.serverId, resolution.cwd, resolution.path]);
}

export function getAssistantImageMetadata(
  input: AssistantImageContext & { source: string },
): AssistantImageMetadata | null {
  const key = getAssistantImageMetadataKey(input);
  const metadata = key ? assistantImageMetadataCache.get(key) : undefined;
  if (!key || !metadata) {
    return null;
  }
  touchCacheEntry(assistantImageMetadataCache, key, metadata, ASSISTANT_IMAGE_METADATA_CACHE_LIMIT);
  return metadata;
}

export function setAssistantImageMetadata(
  input: AssistantImageContext & { source: string },
  dimensions: { width: number; height: number },
): AssistantImageMetadata | null {
  const { width, height } = dimensions;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const metadata: AssistantImageMetadata = {
    width,
    height,
    aspectRatio: width / height,
  };

  const key = getAssistantImageMetadataKey(input);
  if (key) {
    touchCacheEntry(
      assistantImageMetadataCache,
      key,
      metadata,
      ASSISTANT_IMAGE_METADATA_CACHE_LIMIT,
    );
  }

  return metadata;
}

export function extractAssistantImageSources(markdown: string): string[] {
  const shouldCacheParse = !/data:image\//i.test(markdown);
  const cachedParse = shouldCacheParse ? assistantImageParseCache.get(markdown) : undefined;
  if (cachedParse) {
    touchCacheEntry(
      assistantImageParseCache,
      markdown,
      cachedParse,
      ASSISTANT_IMAGE_PARSE_CACHE_LIMIT,
    );
    return cachedParse.sources;
  }

  const parsed = parseAssistantImageMarkdown(markdown);
  if (shouldCacheParse) {
    touchCacheEntry(assistantImageParseCache, markdown, parsed, ASSISTANT_IMAGE_PARSE_CACHE_LIMIT);
  }
  return parsed.sources;
}

export function estimateAssistantMessageHeightFromCache(
  markdown: string,
  contentMaxWidth: number,
  imageContext?: AssistantImageContext,
): number | null {
  const parsed = assistantImageParseCache.get(markdown) ?? parseAssistantImageMarkdown(markdown);
  if (parsed.sources.length === 0) {
    return null;
  }

  const imageHeights = parsed.sources.map((source) => {
    const aspectRatio =
      getAssistantImageMetadata({ source, ...imageContext })?.aspectRatio ??
      ASSISTANT_IMAGE_DEFAULT_ASPECT_RATIO;
    return Math.max(
      ASSISTANT_IMAGE_MIN_HEIGHT,
      Math.round((contentMaxWidth - ASSISTANT_IMAGE_INSET) / aspectRatio),
    );
  });

  const baseHeight = parsed.hasNonImageText
    ? ASSISTANT_MESSAGE_BASE_HEIGHT
    : ASSISTANT_MESSAGE_IMAGE_ONLY_BASE_HEIGHT;

  const estimatedHeight =
    baseHeight +
    imageHeights.reduce((sum, height) => sum + height, 0) +
    ASSISTANT_IMAGE_BLOCK_GAP * imageHeights.length;

  return Math.max(ASSISTANT_MESSAGE_MIN_HEIGHT, estimatedHeight);
}

export function clearAssistantImageMetadataCache(): void {
  assistantImageMetadataCache.clear();
  assistantImageParseCache.clear();
}
