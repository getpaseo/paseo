import { findUnescapedDelimiter } from "./markdown-math";

function getFenceDelimiter(line: string) {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[2] ?? null;
}
interface DisplayMathDelimiter {
  closing: "$$" | "\\]";
  closesOnOpeningLine: boolean;
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

function getDisplayMathDelimiter(line: string): DisplayMathDelimiter | null {
  const content = stripMarkdownContainerPrefix(line);
  const match = /^ {0,3}(\$\$|\\\[)/.exec(content);
  if (!match) {
    return null;
  }

  const opening = match[1];
  const closing = opening === "$$" ? "$$" : "\\]";
  const remainder = content.slice(match[0].length);
  return {
    closing,
    closesOnOpeningLine: findUnescapedDelimiter(remainder, closing) !== -1,
  };
}

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let activeFenceCharacter: "`" | "~" | null = null;
  let activeFenceLength = 0;
  let activeDisplayMathClosing: DisplayMathDelimiter["closing"] | null = null;
  let sawBlockSeparator = false;

  for (const line of text.split("\n")) {
    const isBlankLine = line.trim().length === 0;
    const isInsideProtectedBlock =
      activeFenceCharacter !== null || activeDisplayMathClosing !== null;

    if (!isInsideProtectedBlock && isBlankLine) {
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

    if (activeDisplayMathClosing) {
      if (findUnescapedDelimiter(line, activeDisplayMathClosing) !== -1) {
        activeDisplayMathClosing = null;
      }
      continue;
    }

    const fenceDelimiter = getFenceDelimiter(line);
    if (activeFenceCharacter) {
      if (
        fenceDelimiter?.[0] === activeFenceCharacter &&
        fenceDelimiter.length >= activeFenceLength
      ) {
        activeFenceCharacter = null;
        activeFenceLength = 0;
      }
      continue;
    }

    if (fenceDelimiter) {
      activeFenceCharacter = fenceDelimiter[0] as "`" | "~";
      activeFenceLength = fenceDelimiter.length;
      continue;
    }

    const displayMathDelimiter = getDisplayMathDelimiter(line);
    if (displayMathDelimiter && !displayMathDelimiter.closesOnOpeningLine) {
      activeDisplayMathClosing = displayMathDelimiter.closing;
    }
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }

  return blocks.filter((block) => block.length > 0);
}
