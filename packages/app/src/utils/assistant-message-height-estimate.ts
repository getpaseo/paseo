import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { estimateAssistantMessageHeightFromCache as estimateAssistantImageMessageHeightFromCache } from "@/utils/assistant-image-metadata";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

const ASSISTANT_MARKDOWN_BLOCK_HEIGHT_CACHE_LIMIT = 1000;
const ASSISTANT_MARKDOWN_BLOCK_ESTIMATE_WIDTH = MAX_CONTENT_WIDTH - 16;
const ASSISTANT_MESSAGE_VERTICAL_PADDING = 24;
const ASSISTANT_MARKDOWN_BLOCK_GAP = 12;

interface MarkdownBlockHeightInput {
  block: string;
  width: number;
}

const assistantMarkdownBlockHeightCache = new Map<string, number>();

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

function hashMarkdownBlock(block: string): string {
  let hash = 2166136261;
  for (let index = 0; index < block.length; index += 1) {
    hash ^= block.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${block.length}:${(hash >>> 0).toString(36)}`;
}

function normalizeMarkdownBlockWidth(width: number): number | null {
  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }
  return Math.round(width);
}

function createMarkdownBlockHeightKey(input: MarkdownBlockHeightInput): string | null {
  const normalizedWidth = normalizeMarkdownBlockWidth(input.width);
  if (normalizedWidth === null) {
    return null;
  }
  if (input.block.length === 0) {
    return null;
  }
  return `${normalizedWidth}:${hashMarkdownBlock(input.block)}`;
}

export function setAssistantMarkdownBlockHeight(input: {
  block: string;
  width: number;
  height: number;
}): number | null {
  if (!Number.isFinite(input.height) || input.height <= 0) {
    return null;
  }
  const key = createMarkdownBlockHeightKey({
    block: input.block,
    width: input.width,
  });
  if (!key) {
    return null;
  }
  const height = Math.ceil(input.height);
  touchCacheEntry(
    assistantMarkdownBlockHeightCache,
    key,
    height,
    ASSISTANT_MARKDOWN_BLOCK_HEIGHT_CACHE_LIMIT,
  );
  return height;
}

function estimateAssistantMarkdownBlockHeightFromCache(markdown: string): number | null {
  const blocks = splitMarkdownBlocks(markdown);
  if (blocks.length === 0) {
    return null;
  }

  let blockHeight = 0;
  for (const block of blocks) {
    const key = createMarkdownBlockHeightKey({
      block,
      width: ASSISTANT_MARKDOWN_BLOCK_ESTIMATE_WIDTH,
    });
    const cachedHeight = key ? assistantMarkdownBlockHeightCache.get(key) : undefined;
    if (cachedHeight === undefined) {
      return null;
    }
    blockHeight += cachedHeight;
  }

  return (
    ASSISTANT_MESSAGE_VERTICAL_PADDING +
    blockHeight +
    ASSISTANT_MARKDOWN_BLOCK_GAP * Math.max(0, blocks.length - 1)
  );
}

export function estimateAssistantMessageHeightFromCache(markdown: string): number | null {
  return (
    estimateAssistantMarkdownBlockHeightFromCache(markdown) ??
    estimateAssistantImageMessageHeightFromCache(markdown)
  );
}

export function clearAssistantMessageHeightEstimateCache(): void {
  assistantMarkdownBlockHeightCache.clear();
}
