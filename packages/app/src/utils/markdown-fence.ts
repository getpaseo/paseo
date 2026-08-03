import type MarkdownIt from "markdown-it";

interface FenceMetadata {
  isClosed: boolean;
}

interface FenceToken {
  type: string;
  map: [number, number] | null;
  meta: unknown;
}

function fenceDelimiter(line: string): string | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[2] ?? null;
}

function isClosingFence(line: string, openingDelimiter: string): boolean {
  const character = openingDelimiter[0];
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  const closingDelimiter = match?.[2];
  return Boolean(
    closingDelimiter &&
    closingDelimiter[0] === character &&
    closingDelimiter.length >= openingDelimiter.length,
  );
}

function fenceMetadata(token: FenceToken, lines: string[]): FenceMetadata {
  if (!token.map) {
    return { isClosed: false };
  }

  const [startLine, endLine] = token.map;
  const openingDelimiter = fenceDelimiter(lines[startLine] ?? "");
  const closingLine = lines[endLine - 1] ?? "";
  return {
    isClosed: Boolean(openingDelimiter && isClosingFence(closingLine, openingDelimiter)),
  };
}

export function installMarkdownFenceMetadata(parser: MarkdownIt): void {
  parser.core.ruler.push("paseo_fence_metadata", (state) => {
    const lines = state.src.split("\n");
    for (const token of state.tokens) {
      if (token.type === "fence") {
        token.meta = fenceMetadata(token, lines);
      }
    }
  });
}

export function isMermaidFenceInfo(info: string | null | undefined): boolean {
  const language = info?.trim().split(/\s+/)[0]?.replace(/^\./, "").toLowerCase();
  return language === "mermaid";
}

export function isClosedFenceMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Reflect.get(value, "isClosed") === true;
}
