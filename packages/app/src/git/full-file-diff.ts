import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

type DiffHunk = ParsedDiffFile["hunks"][number];
type DiffLine = DiffHunk["lines"][number];
type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

export type FullFileDiffUnavailableReason = "binary" | "too_large" | "missing" | "out_of_sync";

export type FullFileDiffResult =
  | { kind: "ready"; file: ParsedDiffFile }
  | { kind: "unavailable"; reason: FullFileDiffUnavailableReason };

/** Splits file text into lines the way git counts them: a trailing newline ends the last line. */
export function splitFileLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Whitespace-only comparison keeps `git diff -w` hunks aligned: with whitespace
// ignored, git may print a context line from the old side while the file on disk
// carries the new indentation.
function sameLine(left: string, right: string): boolean {
  if (left === right) return true;
  return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
}

// A zero-count range starts at the line *before* the change ("+4,0" inserts nothing after line 4).
function firstLineOfRange(start: number, count: number): number {
  return count === 0 ? start + 1 : start;
}

/**
 * Expands a file's diff hunks into one hunk spanning the whole file. Unchanged lines
 * between hunks come from `newContent`, the file as it exists on the new side of the
 * diff. Hunk lines are checked against that content, so a file that moved on since the
 * diff was computed reports `out_of_sync` instead of rendering misaligned lines.
 *
 * `newTokens` optionally holds syntax tokens per line of `newContent`. They replace the
 * server tokens for new-side lines so highlighting stays consistent across the file.
 */
export function buildFullFileDiff(input: {
  file: ParsedDiffFile;
  newContent: string | null;
  newTokens?: readonly (readonly HighlightToken[])[] | null;
}): FullFileDiffResult {
  const { file } = input;
  if (file.status === "binary") return { kind: "unavailable", reason: "binary" };
  if (file.status === "too_large") return { kind: "unavailable", reason: "too_large" };

  if (file.isDeleted) {
    // A deleted file's diff already carries every old line.
    return { kind: "ready", file: mergeHunks(file) };
  }
  if (input.newContent === null) return { kind: "unavailable", reason: "missing" };

  const newLines = splitFileLines(input.newContent);
  const tokensFor = (lineNumber: number): DiffLine["tokens"] => {
    const tokens = input.newTokens?.[lineNumber - 1];
    return tokens ? [...tokens] : undefined;
  };
  const contextLine = (lineNumber: number): DiffLine => {
    const tokens = tokensFor(lineNumber);
    return {
      type: "context",
      content: newLines[lineNumber - 1]!,
      ...(tokens ? { tokens } : {}),
    };
  };

  const lines: DiffLine[] = [];
  let nextNewLine = 1;
  let nextOldLine = 1;
  const hunks = [...file.hunks].sort((left, right) => left.newStart - right.newStart);

  for (const hunk of hunks) {
    const hunkFirstNewLine = firstLineOfRange(hunk.newStart, hunk.newCount);
    const hunkFirstOldLine = firstLineOfRange(hunk.oldStart, hunk.oldCount);
    const gap = hunkFirstNewLine - nextNewLine;
    if (
      gap < 0 ||
      hunkFirstOldLine - nextOldLine !== gap ||
      hunkFirstNewLine - 1 > newLines.length
    ) {
      return { kind: "unavailable", reason: "out_of_sync" };
    }
    for (let lineNumber = nextNewLine; lineNumber < hunkFirstNewLine; lineNumber += 1) {
      lines.push(contextLine(lineNumber));
    }
    nextNewLine = hunkFirstNewLine;
    nextOldLine = hunkFirstOldLine;

    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      if (line.type === "remove") {
        lines.push(line);
        nextOldLine += 1;
        continue;
      }
      const fileLine = newLines[nextNewLine - 1];
      if (fileLine === undefined || !sameLine(fileLine, line.content)) {
        return { kind: "unavailable", reason: "out_of_sync" };
      }
      const tokens = tokensFor(nextNewLine) ?? line.tokens;
      lines.push({ type: line.type, content: fileLine, ...(tokens ? { tokens } : {}) });
      nextNewLine += 1;
      if (line.type === "context") nextOldLine += 1;
    }
  }

  for (let lineNumber = nextNewLine; lineNumber <= newLines.length; lineNumber += 1) {
    lines.push(contextLine(lineNumber));
  }

  return { kind: "ready", file: withSingleHunk(file, lines) };
}

function mergeHunks(file: ParsedDiffFile): ParsedDiffFile {
  const lines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type !== "header") lines.push(line);
    }
  }
  return withSingleHunk(file, lines);
}

function withSingleHunk(file: ParsedDiffFile, lines: DiffLine[]): ParsedDiffFile {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.type !== "add") oldCount += 1;
    if (line.type !== "remove") newCount += 1;
  }
  return {
    ...file,
    hunks: [{ oldStart: 1, oldCount, newStart: 1, newCount, lines }],
  };
}

/**
 * Stable identity for the diff a full-file expansion was built from. Structural sharing
 * usually preserves object identity, but panels subscribed under different query scopes
 * receive equal diffs as distinct objects.
 */
export function diffFileSignature(file: ParsedDiffFile): string {
  const hunks = file.hunks.map(
    (hunk) =>
      `${hunk.oldStart},${hunk.oldCount},${hunk.newStart},${hunk.newCount},${hunk.lines.length}`,
  );
  return [file.path, file.status ?? "ok", file.additions, file.deletions, ...hunks].join("|");
}
