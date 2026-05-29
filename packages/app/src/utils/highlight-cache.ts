import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Shared, theme-independent tokenization + cache for syntax highlighting.
// Used by markdown code blocks, file preview, and tool-call detail blocks
// (Edit diff / Write / Read). Colors are applied at render time, so the cache
// key is just (extension, code) and one entry serves both light and dark.

export interface KeyedToken {
  key: string;
  token: HighlightToken;
}

export interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

// Above this, highlighting a whole document on the main thread risks a visible
// stall when a large Read/Write block is expanded. Callers fall back to plain
// monospace text. Generous enough to cover the vast majority of real blocks.
export const MAX_HIGHLIGHT_CHARS = 100_000;

class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const tokenizationCache = new LRUCache<string, HighlightToken[][]>(200);

// Tokenize `code` to per-line tokens, cached. Returns null when the language is
// unsupported, the input is over the size cap, or parsing throws — callers then
// render plain text.
export function tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
  if (!ext) return null;
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const cacheKey = `${ext}:${code}`;
  const cached = tokenizationCache.get(cacheKey);
  if (cached) return cached;
  let lines: HighlightToken[][];
  try {
    lines = highlightCode(code, `x.${ext}`);
  } catch {
    return null;
  }
  tokenizationCache.set(cacheKey, lines);
  return lines;
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      token,
    })),
  };
}

export function highlightToKeyedLines(code: string, ext: string | null): KeyedLine[] | null {
  const lines = tokenizeToLines(code, ext);
  return lines ? lines.map(toKeyedLine) : null;
}

// Extension for grammar selection from a file path. We only need the suffix —
// absolute vs relative paths are equivalent here.
export function extensionFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
