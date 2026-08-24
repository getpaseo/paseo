import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { createImageSourceCacheKey } from "@/attachments/utils";

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
const ASSISTANT_IMAGE_ESTIMATE_WIDTH = MAX_CONTENT_WIDTH - 8;
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

function createSourceAliasKey(source: string): string {
  return `source:${createImageSourceCacheKey(source)}`;
}

function createResolutionKey(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): string | null {
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
  return `file:${input.serverId ?? "unknown-server"}:${resolution.cwd}:${resolution.path}`;
}

function getAssistantImageMetadataKeys(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): string[] {
  const source = input.source.trim();
  if (!source) {
    return [];
  }

  const keys = [createSourceAliasKey(source)];
  const resolutionKey = createResolutionKey(input);
  if (resolutionKey) {
    keys.unshift(resolutionKey);
  }
  return [...new Set(keys)];
}

export function getAssistantImageMetadata(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): AssistantImageMetadata | null {
  for (const key of getAssistantImageMetadataKeys(input)) {
    const metadata = assistantImageMetadataCache.get(key);
    if (metadata) {
      touchCacheEntry(
        assistantImageMetadataCache,
        key,
        metadata,
        ASSISTANT_IMAGE_METADATA_CACHE_LIMIT,
      );
      return metadata;
    }
  }
  return null;
}

export function setAssistantImageMetadata(
  input: {
    source: string;
    workspaceRoot?: string;
    serverId?: string;
  },
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

  for (const key of getAssistantImageMetadataKeys(input)) {
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

export function estimateAssistantMessageHeightFromCache(markdown: string): number | null {
  const parsed = assistantImageParseCache.get(markdown) ?? parseAssistantImageMarkdown(markdown);
  if (parsed.sources.length === 0) {
    return null;
  }

  const knownHeights = parsed.sources
    .map((source) => getAssistantImageMetadata({ source }))
    .filter((metadata): metadata is AssistantImageMetadata => metadata !== null)
    .map((metadata) =>
      Math.max(
        ASSISTANT_IMAGE_MIN_HEIGHT,
        Math.round(ASSISTANT_IMAGE_ESTIMATE_WIDTH / metadata.aspectRatio),
      ),
    );

  if (knownHeights.length === 0) {
    return null;
  }

  const baseHeight = parsed.hasNonImageText
    ? ASSISTANT_MESSAGE_BASE_HEIGHT
    : ASSISTANT_MESSAGE_IMAGE_ONLY_BASE_HEIGHT;

  const estimatedHeight =
    baseHeight +
    knownHeights.reduce((sum, height) => sum + height, 0) +
    ASSISTANT_IMAGE_BLOCK_GAP * knownHeights.length;

  return Math.max(ASSISTANT_MESSAGE_MIN_HEIGHT, estimatedHeight);
}

export function clearAssistantImageMetadataCache(): void {
  assistantImageMetadataCache.clear();
  assistantImageParseCache.clear();
}
