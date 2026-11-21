const ASSISTANT_MESSAGE_HEIGHT_CACHE_LIMIT = 1000;

interface MessageHeightInput {
  markdown: string;
  width: number;
}

const assistantMessageHeightCache = new Map<string, number>();

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

function hashMessage(markdown: string): string {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${markdown.length}:${(hash >>> 0).toString(36)}`;
}

function normalizeMessageWidth(width: number): number | null {
  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }
  return Math.round(width);
}

function createMessageHeightKey(input: MessageHeightInput): string | null {
  const normalizedWidth = normalizeMessageWidth(input.width);
  if (normalizedWidth === null) {
    return null;
  }
  if (input.markdown.length === 0) {
    return null;
  }
  return `${normalizedWidth}:${hashMessage(input.markdown)}`;
}

export function setAssistantMessageHeight(input: {
  markdown: string;
  width: number;
  height: number;
}): number | null {
  if (!Number.isFinite(input.height) || input.height <= 0) {
    return null;
  }
  const key = createMessageHeightKey({
    markdown: input.markdown,
    width: input.width,
  });
  if (!key) {
    return null;
  }
  const height = Math.ceil(input.height);
  touchCacheEntry(assistantMessageHeightCache, key, height, ASSISTANT_MESSAGE_HEIGHT_CACHE_LIMIT);
  return height;
}

export function estimateAssistantMessageHeightFromCache({
  markdown,
  contentMaxWidth,
}: {
  markdown: string;
  contentMaxWidth: number;
}): number | null {
  return (
    assistantMessageHeightCache.get(
      createMessageHeightKey({ markdown: markdown, width: contentMaxWidth }) ?? "",
    ) ?? null
  );
}

export function clearAssistantMessageHeightEstimateCache(): void {
  assistantMessageHeightCache.clear();
}
