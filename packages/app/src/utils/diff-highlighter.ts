import {
  highlightCode,
  isLanguageSupported,
  type HighlightToken,
} from "./syntax-highlighter";

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  lineNumber?: number; // Line number in the original/new file
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
}

/**
 * Parse a unified diff into structured data
 */
export function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const firstLine = lines[0];

    // Detect new/deleted file
    const isNew =
      section.includes("new file mode") ||
      section.includes("--- /dev/null");
    const isDeleted =
      section.includes("deleted file mode") ||
      section.includes("+++ /dev/null");

    // Extract path
    let path = "unknown";
    const pathMatch = firstLine.match(/a\/(.*?) b\//);
    if (pathMatch) {
      path = pathMatch[1];
    } else {
      const newFileMatch = firstLine.match(/b\/(.+)$/);
      if (newFileMatch) {
        path = newFileMatch[1];
      }
    }

    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let additions = 0;
    let deletions = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Skip metadata lines
      if (line.startsWith("index ")) continue;
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("+++ ")) continue;
      if (line.startsWith("new file mode")) continue;
      if (line.startsWith("deleted file mode")) continue;

      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: parseInt(hunkMatch[2] ?? "1", 10),
          newStart: parseInt(hunkMatch[3], 10),
          newCount: parseInt(hunkMatch[4] ?? "1", 10),
          lines: [{ type: "header", content: line.match(/^(@@ .+? @@)/)?.[1] ?? line }],
        };
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
        // Non-empty line that's not a "\ No newline" marker
        currentHunk.lines.push({ type: "context", content: line });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

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
      // Remove lines don't appear in the new file
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
      // Add lines don't appear in the old file
    }
  }

  return lines;
}

/**
 * Apply syntax highlighting to diff hunks.
 *
 * Strategy:
 * 1. Reconstruct both old and new file versions from the hunks
 * 2. Highlight each version as a complete file
 * 3. Map highlighted tokens back to diff lines using line numbers
 */
export function highlightDiffFile(file: ParsedDiffFile): ParsedDiffFile {
  if (!isLanguageSupported(file.path)) {
    return file;
  }

  // Reconstruct both versions
  const newFileLines = reconstructNewFile(file.hunks);
  const oldFileLines = reconstructOldFile(file.hunks);

  // Build complete file content strings for highlighting
  const newFileContent = buildFileContent(newFileLines);
  const oldFileContent = buildFileContent(oldFileLines);

  // Highlight both versions
  const newHighlighted = highlightCode(newFileContent, file.path);
  const oldHighlighted = highlightCode(oldFileContent, file.path);

  // Build lookup maps: line number -> tokens
  const newTokensByLine = buildTokenLookup(newFileLines, newHighlighted);
  const oldTokensByLine = buildTokenLookup(oldFileLines, oldHighlighted);

  // Apply tokens to hunks
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

function buildTokenLookup(
  lineMap: Map<number, string>,
  highlighted: HighlightToken[][]
): Map<number, HighlightToken[]> {
  const lookup = new Map<number, HighlightToken[]>();

  if (lineMap.size === 0) return lookup;

  const lineNumbers = Array.from(lineMap.keys()).sort((a, b) => a - b);
  const minLine = lineNumbers[0];

  // highlighted array is 0-indexed, line numbers are 1-indexed
  for (let i = 0; i < highlighted.length; i++) {
    const lineNum = minLine + i;
    if (lineMap.has(lineNum)) {
      lookup.set(lineNum, highlighted[i]);
    }
  }

  return lookup;
}

/**
 * Parse and highlight a complete diff
 */
export function parseAndHighlightDiff(diffText: string): ParsedDiffFile[] {
  const files = parseDiff(diffText);
  return files.map(highlightDiffFile);
}
