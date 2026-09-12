import MarkdownIt from "markdown-it";

const markdownBlockParser = new MarkdownIt();

function isEscaped(source: string, position: number): boolean {
  let backslashCount = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

function findUnescapedDelimiter(source: string, delimiter: string): number {
  let searchStart = 0;

  while (searchStart < source.length) {
    const delimiterStart = source.indexOf(delimiter, searchStart);
    if (delimiterStart === -1) {
      return -1;
    }
    if (!isEscaped(source, delimiterStart)) {
      return delimiterStart;
    }
    searchStart = delimiterStart + delimiter.length;
  }

  return -1;
}

export interface MarkdownBlockDelimiter {
  open: string;
  close: string;
}

export interface SplitMarkdownBlocksOptions {
  blockDelimiters?: readonly MarkdownBlockDelimiter[];
  serverId?: string;
}

const registeredBlockDelimitersByHost = new Map<string, readonly MarkdownBlockDelimiter[]>();
const publishedMarkdownBlockDelimiterHosts = new Set<string>();

/** Installed plugins push their declared pairs here; the plugin registry calls this on publish. */
export function setMarkdownBlockDelimiters(
  serverId: string,
  delimiters: readonly MarkdownBlockDelimiter[],
): void {
  registeredBlockDelimitersByHost.set(serverId, delimiters);
  publishedMarkdownBlockDelimiterHosts.add(serverId);
}

export function getMarkdownBlockDelimiters(
  serverId: string | undefined,
): readonly MarkdownBlockDelimiter[] {
  if (!serverId) return [];
  return registeredBlockDelimitersByHost.get(serverId) ?? [];
}

export function hasPublishedMarkdownBlockDelimiters(serverId: string | undefined): boolean {
  return serverId !== undefined && publishedMarkdownBlockDelimiterHosts.has(serverId);
}

export function clearMarkdownBlockDelimiters(serverId?: string): void {
  if (serverId === undefined) {
    registeredBlockDelimitersByHost.clear();
    publishedMarkdownBlockDelimiterHosts.clear();
    return;
  }
  registeredBlockDelimitersByHost.delete(serverId);
  publishedMarkdownBlockDelimiterHosts.delete(serverId);
}

function stripMarkdownContainerPrefix(line: string): string {
  let remainder = line;
  let foundContainer = false;

  while (true) {
    const blockquote = /^ {0,3}>[ \t]?/.exec(remainder);
    if (blockquote) {
      remainder = remainder.slice(blockquote[0].length);
      foundContainer = true;
      continue;
    }

    const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(remainder);
    if (listItem) {
      remainder = remainder.slice(listItem[0].length);
      foundContainer = true;
      continue;
    }

    return foundContainer ? remainder : line;
  }
}

interface OpenedBlockDelimiter {
  close: string;
  closesOnOpeningLine: boolean;
}

function getOpenedBlockDelimiter(
  line: string,
  delimiters: readonly MarkdownBlockDelimiter[],
): OpenedBlockDelimiter | null {
  if (delimiters.length === 0) {
    return null;
  }
  const content = stripMarkdownContainerPrefix(line).replace(/^ {0,3}/, "");
  // Longest opener first so "$$" is never read as "$".
  const candidates = [...delimiters].sort((left, right) => right.open.length - left.open.length);
  for (const delimiter of candidates) {
    if (!content.startsWith(delimiter.open)) {
      continue;
    }
    const remainder = content.slice(delimiter.open.length);
    return {
      close: delimiter.close,
      closesOnOpeningLine: findUnescapedDelimiter(remainder, delimiter.close) !== -1,
    };
  }
  return null;
}

function getFenceDelimiter(line: string) {
  const content = stripMarkdownContainerPrefix(line);
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content);
  if (!match) {
    return null;
  }
  return { marker: match[2], remainder: match[3] ?? "" };
}

interface ProtectedBlockState {
  fenceCharacter: "`" | "~" | null;
  fenceLength: number;
  openDelimiterClose: string | null;
}

function updateProtectedBlockState(
  line: string,
  state: ProtectedBlockState,
  delimiters: readonly MarkdownBlockDelimiter[],
): void {
  if (state.openDelimiterClose) {
    if (findUnescapedDelimiter(line, state.openDelimiterClose) !== -1) {
      state.openDelimiterClose = null;
    }
    return;
  }

  const fenceDelimiter = getFenceDelimiter(line);
  if (state.fenceCharacter) {
    if (
      fenceDelimiter &&
      fenceDelimiter.marker[0] === state.fenceCharacter &&
      fenceDelimiter.marker.length >= state.fenceLength &&
      /^[ \t]*$/.test(fenceDelimiter.remainder)
    ) {
      state.fenceCharacter = null;
      state.fenceLength = 0;
    }
    return;
  }

  if (fenceDelimiter) {
    state.fenceCharacter = fenceDelimiter.marker[0] as "`" | "~";
    state.fenceLength = fenceDelimiter.marker.length;
    return;
  }

  const opened = getOpenedBlockDelimiter(line, delimiters);
  if (opened && !opened.closesOnOpeningLine) {
    state.openDelimiterClose = opened.close;
  }
}

export function splitMarkdownBlocks(
  text: string,
  options: SplitMarkdownBlocksOptions = {},
): string[] {
  if (text.length === 0) {
    return [];
  }

  const delimiters = options.blockDelimiters ?? getMarkdownBlockDelimiters(options.serverId);
  const blocks: string[] = [];
  let currentLines: string[] = [];
  const protectedBlockState: ProtectedBlockState = {
    fenceCharacter: null,
    fenceLength: 0,
    openDelimiterClose: null,
  };
  let sawBlockSeparator = false;
  const lines = text.split("\n");
  const structuralBlankLines = getStructuralBlankLines(text, lines);

  for (const [index, line] of lines.entries()) {
    const isBlankLine = line.trim().length === 0;
    const isInsideProtectedBlock =
      protectedBlockState.fenceCharacter !== null ||
      protectedBlockState.openDelimiterClose !== null;

    if (isBlankLine && (isInsideProtectedBlock || structuralBlankLines.has(index))) {
      currentLines.push(line);
      continue;
    }

    if (isBlankLine) {
      if (currentLines.length > 0) {
        sawBlockSeparator = true;
      }
      continue;
    }

    if (!isInsideProtectedBlock && sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);
    updateProtectedBlockState(line, protectedBlockState, delimiters);
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }

  return blocks.filter((block) => block.length > 0);
}

function getStructuralBlankLines(text: string, lines: string[]): Set<number> {
  const blankLines = new Set<number>();
  for (const token of markdownBlockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const [start, end] = token.map;
    for (let index = start; index < end - 1; index += 1) {
      if (lines[index]?.trim().length === 0) {
        blankLines.add(index);
      }
    }
  }
  return blankLines;
}
