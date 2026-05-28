/*
 * Adapted from MIT-licensed upstream terminal link provider behavior.
 * Copyright (c) Microsoft Corporation.
 */

import type { IBufferCell, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import {
  detectTerminalLocalLinks,
  type TerminalLinkSuffix,
  type TerminalParsedLink,
} from "./terminal-local-link-parsing";

export interface TerminalLocalFileLinkSource {
  text: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface TerminalLocalFileLinkTarget {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface TerminalLocalFileLinkProviderOptions {
  resolveLink: (source: TerminalLocalFileLinkSource) => Promise<TerminalLocalFileLinkTarget | null>;
  openLink: (
    target: TerminalLocalFileLinkTarget,
    disposition: "main" | "side",
    event: MouseEvent,
  ) => void;
}

const MAX_LINE_LENGTH = 2_000;
const MAX_LINK_LENGTH = 500;
const MAX_RESOLVED_LINKS_IN_LINE = 10;

export function createTerminalLocalFileLinkProvider(
  terminal: Terminal,
  options: TerminalLocalFileLinkProviderOptions,
): ILinkProvider {
  return new TerminalLocalFileLinkProvider(terminal, options);
}

class TerminalLocalFileLinkProvider implements ILinkProvider {
  private readonly activeRequests = new Map<number, Promise<ILink[]>>();

  constructor(
    private readonly terminal: Terminal,
    private readonly options: TerminalLocalFileLinkProviderOptions,
  ) {}

  async provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): Promise<void> {
    let activeRequest = this.activeRequests.get(bufferLineNumber);
    if (activeRequest) {
      callback(await activeRequest);
      return;
    }

    activeRequest = this.provideLinksForLine(bufferLineNumber);
    this.activeRequests.set(bufferLineNumber, activeRequest);
    const links = await activeRequest;
    this.activeRequests.delete(bufferLineNumber);
    callback(links.length > 0 ? links : undefined);
  }

  private async provideLinksForLine(bufferLineNumber: number): Promise<ILink[]> {
    const windowed = getWindowedLineContent(this.terminal, bufferLineNumber - 1);
    if (!windowed || windowed.text.length === 0 || windowed.text.length > MAX_LINE_LENGTH) {
      return [];
    }

    const parsedLinks = detectTerminalLocalLinks(windowed.text);
    const links: ILink[] = [];
    let resolvedLinkCount = 0;
    for (const parsedLink of parsedLinks) {
      if (parsedLink.path.text.length > MAX_LINK_LENGTH) {
        continue;
      }

      const source = toLinkSource(windowed.text, parsedLink);
      if (!source) {
        continue;
      }

      const target = await this.options.resolveLink(source);
      if (!target) {
        continue;
      }

      const range = toBufferRange({
        terminal: this.terminal,
        startLine: windowed.startLine,
        startIndex: parsedLink.prefix?.index ?? parsedLink.path.index,
        endIndex: getParsedLinkEndIndex(parsedLink),
      });
      if (!range) {
        continue;
      }

      links.push(createLocalFileLink({ range, source, target, options: this.options }));
      resolvedLinkCount += 1;
      if (resolvedLinkCount >= MAX_RESOLVED_LINKS_IN_LINE) {
        break;
      }
    }

    return links;
  }
}

function createLocalFileLink(input: {
  range: IBufferRange;
  source: TerminalLocalFileLinkSource;
  target: TerminalLocalFileLinkTarget;
  options: TerminalLocalFileLinkProviderOptions;
}): ILink {
  return {
    range: input.range,
    text: input.source.text,
    decorations: {
      pointerCursor: true,
      underline: true,
    },
    activate: (event) => {
      event.preventDefault();
      const disposition = event.metaKey || event.ctrlKey ? "side" : "main";
      input.options.openLink(input.target, disposition, event);
    },
  };
}

function toLinkSource(
  lineText: string,
  parsedLink: TerminalParsedLink,
): TerminalLocalFileLinkSource | null {
  const path = trimLikelyTrailingPunctuation(parsedLink.path.text);
  if (!path || path.length !== parsedLink.path.text.length) {
    return null;
  }

  const lineStart = parsedLink.suffix?.row;
  const lineEnd = parsedLink.suffix?.rowEnd;
  const text = formatLinkSourceText({ path, suffix: parsedLink.suffix });
  if (!text) {
    return null;
  }

  const rawLinkText = lineText.slice(
    parsedLink.prefix?.index ?? parsedLink.path.index,
    getParsedLinkEndIndex(parsedLink),
  );
  if (!rawLinkText.trim()) {
    return null;
  }

  return {
    text,
    path,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd && lineStart && lineEnd >= lineStart ? { lineEnd } : {}),
  };
}

function formatLinkSourceText(input: { path: string; suffix?: TerminalLinkSuffix }): string | null {
  const { path, suffix } = input;
  if (!suffix?.row) {
    return path;
  }
  let text = `${path}:${suffix.row}`;
  if (suffix.col) {
    text += `:${suffix.col}`;
  }
  if (suffix.rowEnd) {
    text += `-${suffix.rowEnd}`;
    if (suffix.colEnd) {
      text += `:${suffix.colEnd}`;
    }
  }
  return text;
}

function trimLikelyTrailingPunctuation(value: string): string {
  return value.replace(/[\][["'.]+$/, "");
}

function getParsedLinkEndIndex(parsedLink: TerminalParsedLink): number {
  if (parsedLink.suffix) {
    return parsedLink.suffix.suffix.index + parsedLink.suffix.suffix.text.length;
  }
  return parsedLink.path.index + parsedLink.path.text.length;
}

function getWindowedLineContent(
  terminal: Terminal,
  requestedLine: number,
): { text: string; startLine: number } | null {
  let startLine = requestedLine;
  let endLine = requestedLine;
  const line = terminal.buffer.active.getLine(requestedLine);
  if (!line) {
    return null;
  }

  const lineStrings: string[] = [];
  let contextLength = 0;
  while (
    startLine > 0 &&
    terminal.buffer.active.getLine(startLine)?.isWrapped &&
    contextLength < MAX_LINK_LENGTH
  ) {
    startLine -= 1;
    const previous = terminal.buffer.active.getLine(startLine);
    if (!previous) {
      break;
    }
    contextLength += previous.translateToString(true).length;
  }

  for (let y = startLine; y <= endLine; y += 1) {
    const current = terminal.buffer.active.getLine(y);
    if (current) {
      lineStrings.push(current.translateToString(true));
    }
  }

  contextLength = 0;
  while (
    endLine + 1 < terminal.buffer.active.length &&
    terminal.buffer.active.getLine(endLine + 1)?.isWrapped &&
    contextLength < MAX_LINK_LENGTH
  ) {
    endLine += 1;
    const next = terminal.buffer.active.getLine(endLine);
    if (!next) {
      break;
    }
    const nextText = next.translateToString(true);
    contextLength += nextText.length;
    lineStrings.push(nextText);
  }

  return {
    text: lineStrings.join(""),
    startLine,
  };
}

function toBufferRange(input: {
  terminal: Terminal;
  startLine: number;
  startIndex: number;
  endIndex: number;
}): IBufferRange | null {
  const start = mapStringOffsetToBuffer(input.terminal, input.startLine, input.startIndex);
  if (!start) {
    return null;
  }
  const end = mapStringOffsetToBuffer(input.terminal, input.startLine, input.endIndex);
  if (!start || !end) {
    return null;
  }

  return {
    start: { x: start.x + 1, y: start.y + 1 },
    end: { x: end.x, y: end.y + 1 },
  };
}

function mapStringOffsetToBuffer(
  terminal: Terminal,
  startLine: number,
  offset: number,
): { y: number; x: number } | null {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let y = startLine;
  let charsRemaining = offset;

  while (true) {
    const line = buffer.getLine(y);
    if (!line) {
      return null;
    }
    for (let column = 0; column < line.length; column += 1) {
      if (charsRemaining <= 0) {
        return { y, x: column };
      }
      const currentCell = line.getCell(column, cell) as IBufferCell | undefined;
      const chars = currentCell?.getChars() ?? "";
      const width = currentCell?.getWidth() ?? 0;
      if (width) {
        charsRemaining -= chars.length || 1;
        if (
          isWrappedWideCharacterContinuation({
            buffer,
            cell,
            lineLength: line.length,
            column,
            y,
            chars,
          })
        ) {
          charsRemaining += 1;
        }
      }
      if (charsRemaining <= 0) {
        return { y, x: column + width };
      }
    }
    if (charsRemaining <= 0) {
      return { y, x: line.length };
    }
    y += 1;
  }
}

function isWrappedWideCharacterContinuation(input: {
  buffer: Terminal["buffer"]["active"];
  cell: IBufferCell;
  lineLength: number;
  column: number;
  y: number;
  chars: string;
}): boolean {
  if (input.column !== input.lineLength - 1 || input.chars !== "") {
    return false;
  }
  const nextLine = input.buffer.getLine(input.y + 1);
  const nextCell = nextLine?.getCell(0, input.cell);
  return Boolean(nextLine?.isWrapped && nextCell?.getWidth() === 2);
}
