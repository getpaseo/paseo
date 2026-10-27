import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { resolve } from "node:path";
import {
  highlightCode,
  highlightCodeWithBudget,
  HIGHLIGHT_MAX_SOURCE_BYTES,
  isLanguageSupported,
  type HighlightToken,
} from "@getpaseo/highlight";
import { unquoteGitPath } from "../../utils/git-quoted-path.js";

const MAX_DIFF_HIGHLIGHT_LINE_CHARS = 10_000;

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  tokens?: HighlightToken[];
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  status?: "ok" | "too_large" | "binary";
}

interface HighlightDiffWithFileContentOptions {
  signal?: AbortSignal;
  oldFileContent?: string | null;
  newFileContent?: string | null;
}

interface ParseAndHighlightDiffOptions {
  signal?: AbortSignal;
  getOldFileContent?: (file: ParsedDiffFile) => Promise<string | null>;
  getNewFileContent?: (file: ParsedDiffFile) => Promise<string | null>;
}

/**
 * Parse a unified diff into structured data
 */
// Git's default patch headers use paired a/path and b/path prefixes, while
// diff.noprefix emits plain paths that may legitimately start with a/ or b/.
function usesDiffPathPrefixes(oldPath: string, newPath: string): boolean {
  return oldPath.startsWith("a/") && newPath.startsWith("b/");
}

function extractPathFromMetadata(lines: string[], prefix: "--- " | "+++ "): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return null;
  }

  const path = unquoteGitPath(line.slice(prefix.length).replace(/\t.*$/, ""));
  return path === "/dev/null" ? null : path;
}

function extractPathFromDiffHeader(lines: string[]): string {
  const firstLine = lines[0] ?? "";
  const prefixedPathMatch = firstLine.match(/^a\/(.+) b\/(.+)$/);
  if (prefixedPathMatch) {
    return prefixedPathMatch[2];
  }

  const quotedPathMatch =
    firstLine.match(/^("(?:\\.|[^"\\])*") (.+)$/) ?? firstLine.match(/^(.+) ("(?:\\.|[^"\\])*")$/);
  if (quotedPathMatch) {
    const oldPath = unquoteGitPath(quotedPathMatch[1]);
    const newPath = unquoteGitPath(quotedPathMatch[2]);
    if (usesDiffPathPrefixes(oldPath, newPath)) {
      return newPath.slice(2);
    }
    return newPath;
  }

  const metadataPath =
    extractPathFromMetadata(lines, "+++ ") ?? extractPathFromMetadata(lines, "--- ");
  if (metadataPath) {
    return metadataPath;
  }

  const pathMatch = firstLine.match(/^(\S+)\s+(\S+)$/);
  if (pathMatch) {
    const [, oldPath, newPath] = pathMatch;
    const path = newPath === "/dev/null" ? oldPath : newPath;
    return usesDiffPathPrefixes(oldPath, newPath) ? path.slice(2) : path;
  }
  return "unknown";
}

function parseHunkHeader(line: string): DiffHunk | null {
  const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!hunkMatch) return null;
  return {
    oldStart: parseInt(hunkMatch[1], 10),
    oldCount: parseInt(hunkMatch[2] ?? "1", 10),
    newStart: parseInt(hunkMatch[3], 10),
    newCount: parseInt(hunkMatch[4] ?? "1", 10),
    lines: [{ type: "header", content: line.match(/^(@@ .+? @@)/)?.[1] ?? line }],
  };
}

interface ParsedSectionBody {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function parseSectionBody(lines: string[]): ParsedSectionBody {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let additions = 0;
  let deletions = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    const newHunk = parseHunkHeader(line);
    if (newHunk) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = newHunk;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (line.length > 0 && !line.startsWith("\\")) {
      currentHunk.lines.push({ type: "context", content: line });
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return { hunks, additions, deletions };
}

export function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    const isNew = section.includes("new file mode") || section.includes("--- /dev/null");
    const isDeleted = section.includes("deleted file mode") || section.includes("+++ /dev/null");
    const path = extractPathFromDiffHeader(lines);

    const { hunks, additions, deletions } = parseSectionBody(lines);

    files.push({ path, isNew, isDeleted, additions, deletions, hunks });
  }

  return files;
}

/**
 * Reconstruct the "new" version of a file from diff hunks.
 * Returns a map of new line numbers to their content.
 */
export function reconstructNewFile(hunks: DiffHunk[]): Map<number, string> {
  const lines = new Map<number, string>();

  for (const hunk of hunks) {
    let newLineNum = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.type === "header") continue;

      if (line.type === "add" || line.type === "context") {
        lines.set(newLineNum, line.content);
        newLineNum++;
      }
    }
  }

  return lines;
}

/**
 * Reconstruct the "old" version of a file from diff hunks.
 * Returns a map of old line numbers to their content.
 */
export function reconstructOldFile(hunks: DiffHunk[]): Map<number, string> {
  const lines = new Map<number, string>();

  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;

    for (const line of hunk.lines) {
      if (line.type === "header") continue;

      if (line.type === "remove" || line.type === "context") {
        lines.set(oldLineNum, line.content);
        oldLineNum++;
      }
    }
  }

  return lines;
}

function buildFileContent(lineMap: Map<number, string>): string {
  if (lineMap.size === 0) return "";

  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const minLine = lineNumbers[0];
  const maxLine = lineNumbers[lineNumbers.length - 1];

  const lines: string[] = [];
  for (let i = minLine; i <= maxLine; i++) {
    lines.push(lineMap.get(i) ?? "");
  }

  return lines.join("\n");
}

function hasOversizedLine(content: string): boolean {
  let lineStart = 0;
  for (let index = 0; index <= content.length; index++) {
    if (index !== content.length && content.charCodeAt(index) !== 10) continue;
    if (index - lineStart > MAX_DIFF_HIGHLIGHT_LINE_CHARS) return true;
    lineStart = index + 1;
  }
  return false;
}

function hasOversizedDiffLine(file: ParsedDiffFile): boolean {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.content.length > MAX_DIFF_HIGHLIGHT_LINE_CHARS) return true;
    }
  }
  return false;
}

function buildTokenLookup(
  lineMap: Map<number, string>,
  highlighted: HighlightToken[][],
): Map<number, HighlightToken[]> {
  const lookup = new Map<number, HighlightToken[]>();

  if (lineMap.size === 0) return lookup;

  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const minLine = lineNumbers[0];

  for (let i = 0; i < highlighted.length; i++) {
    const lineNum = minLine + i;
    if (lineMap.has(lineNum)) {
      lookup.set(lineNum, highlighted[i]);
    }
  }

  return lookup;
}

async function buildFullFileTokenLookup(
  fileContent: string,
  path: string,
  signal?: AbortSignal,
): Promise<Map<number, HighlightToken[]> | null> {
  const highlighted = await highlightCodeWithBudget(fileContent, path, {
    yieldToEventLoop: setImmediate,
    signal,
  });
  if (!highlighted) return null;
  return new Map(highlighted.map((tokens, index) => [index + 1, tokens]));
}

async function readHighlightSource(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > HIGHLIGHT_MAX_SOURCE_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, HIGHLIGHT_MAX_SOURCE_BYTES) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A full buffer includes the extra byte: the source grew after stat.
    return offset === buffer.length ? null : buffer.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function exceedsSourceBudget(content: string): boolean {
  return (
    content.length > HIGHLIGHT_MAX_SOURCE_BYTES ||
    Buffer.byteLength(content) > HIGHLIGHT_MAX_SOURCE_BYTES
  );
}

async function buildBudgetedReconstructedTokens(file: ParsedDiffFile, signal?: AbortSignal) {
  const newLines = reconstructNewFile(file.hunks);
  const oldLines = reconstructOldFile(file.hunks);
  const build = async (lines: Map<number, string>) => {
    // Sparse hunks can be far apart. Admit the span before filling its gaps.
    const numbers = Array.from(lines.keys());
    if (numbers.length && numbers[numbers.length - 1] - numbers[0] > HIGHLIGHT_MAX_SOURCE_BYTES)
      return null;
    let bytes = 0;
    for (const line of lines.values()) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > HIGHLIGHT_MAX_SOURCE_BYTES) return null;
    }
    const highlighted = await highlightCodeWithBudget(buildFileContent(lines), file.path, {
      yieldToEventLoop: setImmediate,
      signal,
    });
    return highlighted ? buildTokenLookup(lines, highlighted) : null;
  };
  const newTokensByLine = await build(newLines);
  if (!newTokensByLine) return null;
  const oldTokensByLine = await build(oldLines);
  return oldTokensByLine ? { newTokensByLine, oldTokensByLine } : null;
}

function buildReconstructedTokenLookups(file: ParsedDiffFile): {
  newTokensByLine: Map<number, HighlightToken[]>;
  oldTokensByLine: Map<number, HighlightToken[]>;
} {
  const newFileLines = reconstructNewFile(file.hunks);
  const oldFileLines = reconstructOldFile(file.hunks);
  const newFileContent = buildFileContent(newFileLines);
  const oldFileContent = buildFileContent(oldFileLines);
  const newHighlighted = highlightCode(newFileContent, file.path);
  const oldHighlighted = highlightCode(oldFileContent, file.path);

  return {
    newTokensByLine: buildTokenLookup(newFileLines, newHighlighted),
    oldTokensByLine: buildTokenLookup(oldFileLines, oldHighlighted),
  };
}

/**
 * Apply syntax highlighting to diff hunks using reconstructed file content.
 * This is the fallback when actual file content is not available.
 */
export function highlightDiffFromHunks(file: ParsedDiffFile): ParsedDiffFile {
  if (!isLanguageSupported(file.path) || hasOversizedDiffLine(file)) {
    return file;
  }

  const reconstructedTokens = buildReconstructedTokenLookups(file);
  return applyTokensToHunks(
    file,
    reconstructedTokens.newTokensByLine,
    reconstructedTokens.oldTokensByLine,
  );
}

/**
 * Apply syntax highlighting to diff hunks using actual file content.
 * This provides better context for the parser.
 */
export async function highlightDiffWithFileContent(
  file: ParsedDiffFile,
  cwd: string,
  options: HighlightDiffWithFileContentOptions = {},
): Promise<ParsedDiffFile> {
  if (!isDiffHighlightEligible(file, options)) return file;

  const newContent =
    typeof options.newFileContent === "string"
      ? options.newFileContent
      : await readHighlightSource(resolve(cwd, file.path));
  if (options.signal?.aborted) return file;

  const oldTokens = await highlightAvailableSource(
    options.oldFileContent,
    file.path,
    options.signal,
  );
  if (options.signal?.aborted) return file;
  const newTokens = await highlightAvailableSource(newContent, file.path, options.signal);
  if (options.signal?.aborted) return file;
  if (oldTokens && newTokens) return applyTokensToHunks(file, newTokens, oldTokens);
  const reconstructed = await buildBudgetedReconstructedTokens(file, options.signal);
  if (!reconstructed || options.signal?.aborted) return file;
  return applyTokensToHunks(
    file,
    newTokens ?? reconstructed.newTokensByLine,
    oldTokens ?? reconstructed.oldTokensByLine,
  );
}

function isDiffHighlightEligible(
  file: ParsedDiffFile,
  options: HighlightDiffWithFileContentOptions,
): boolean {
  return !options.signal?.aborted && isLanguageSupported(file.path) && !hasOversizedDiffLine(file);
}

async function highlightAvailableSource(
  content: string | null | undefined,
  path: string,
  signal?: AbortSignal,
): Promise<Map<number, HighlightToken[]> | null> {
  // Preserve the existing hunk-context fallback for oversized individual lines.
  if (typeof content !== "string" || exceedsSourceBudget(content) || hasOversizedLine(content))
    return null;
  return buildFullFileTokenLookup(content, path, signal);
}

function applyTokensToHunks(
  file: ParsedDiffFile,
  newTokensByLine: Map<number, HighlightToken[]>,
  oldTokensByLine: Map<number, HighlightToken[]>,
): ParsedDiffFile {
  const highlightedHunks = file.hunks.map((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    const highlightedLines = hunk.lines.map((line): DiffLine => {
      if (line.type === "header") {
        return line;
      }

      let tokens: HighlightToken[] | undefined;

      if (line.type === "add") {
        tokens = newTokensByLine.get(newLineNum);
        newLineNum++;
      } else if (line.type === "remove") {
        tokens = oldTokensByLine.get(oldLineNum);
        oldLineNum++;
      } else if (line.type === "context") {
        // Context lines exist in both - use new file version
        tokens = newTokensByLine.get(newLineNum);
        oldLineNum++;
        newLineNum++;
      }

      return tokens ? { ...line, tokens } : line;
    });

    return { ...hunk, lines: highlightedLines };
  });

  return { ...file, hunks: highlightedHunks };
}

/**
 * Parse and highlight a complete diff, using actual file content when available.
 */
export async function parseAndHighlightDiff(
  diffText: string,
  cwd: string,
  options: ParseAndHighlightDiffOptions = {},
): Promise<ParsedDiffFile[]> {
  const files = parseDiff(diffText);

  const highlightedFiles: ParsedDiffFile[] = [];
  for (const file of files) {
    if (options.signal?.aborted) {
      highlightedFiles.push(file);
      continue;
    }
    const [oldFileContent, newFileContent] = await Promise.all([
      options.getOldFileContent?.(file),
      options.getNewFileContent?.(file),
    ]);
    highlightedFiles.push(
      await highlightDiffWithFileContent(file, cwd, {
        oldFileContent: oldFileContent ?? undefined,
        newFileContent: newFileContent ?? undefined,
        signal: options.signal,
      }),
    );
  }
  return highlightedFiles;
}

// Re-export types
export type { HighlightToken };
