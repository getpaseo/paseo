import { readFile } from "fs/promises";
import { isAbsolute, join, win32 } from "path";
import { isSkippableWorktreeIncludeError, toSkippedEntry, WorktreeIncludeError } from "./errors.js";
import type {
  ParsedWorktreeIncludeEntries,
  WorktreeIncludeEntry,
  WorktreeIncludeSkippedEntry,
} from "./types.js";

const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";

export async function readWorktreeIncludeEntries(
  sourceRoot: string,
): Promise<ParsedWorktreeIncludeEntries> {
  let contents: string;
  try {
    contents = await readFile(join(sourceRoot, WORKTREE_INCLUDE_FILE_NAME), "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { entries: [], skipped: [] };
    }
    throw error;
  }

  const entries: WorktreeIncludeEntry[] = [];
  const skipped: WorktreeIncludeSkippedEntry[] = [];

  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    try {
      entries.push(parseWorktreeIncludeEntry({ line, lineNumber }));
    } catch (error) {
      if (!isSkippableWorktreeIncludeError(error)) {
        throw error;
      }
      skipped.push(toSkippedEntry({ lineNumber, raw: line }, error));
    }
  }

  return { entries, skipped };
}

export function parseWorktreeIncludeEntry(options: {
  line: string;
  lineNumber: number;
}): WorktreeIncludeEntry {
  let mode: WorktreeIncludeEntry["mode"] = "copy";
  let path = options.line;
  const separatorIndex = options.line.search(/\s/);

  if (separatorIndex === -1) {
    if (options.line === "copy" || options.line === "symlink") {
      throw new WorktreeIncludeError(
        "invalid_entry",
        `.worktreeinclude ${options.line} entry on line ${options.lineNumber} requires a path`,
      );
    }
  } else {
    const verb = options.line.slice(0, separatorIndex);
    if (verb === "copy" || verb === "symlink") {
      mode = verb;
      path = options.line.slice(separatorIndex).trim();
    }
  }

  return {
    lineNumber: options.lineNumber,
    mode,
    raw: options.line,
    relativePath: normalizeRelativePath({ entry: path, lineNumber: options.lineNumber }),
  };
}

export function normalizeRelativePath(options: { entry: string; lineNumber: number }): string {
  const fail = (reason: string): never => {
    throw new WorktreeIncludeError(
      "invalid_entry",
      `Invalid .worktreeinclude entry '${options.entry}' on line ${options.lineNumber}: ${reason}`,
    );
  };

  if (
    options.entry.includes("\0") ||
    options.entry.startsWith("/") ||
    options.entry.startsWith("\\") ||
    isAbsolute(options.entry) ||
    win32.isAbsolute(options.entry) ||
    /^[A-Za-z]:/.test(options.entry)
  ) {
    fail("absolute paths are not allowed");
  }

  const segments = options.entry
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    fail("path must not be empty");
  }

  for (const segment of segments) {
    if (segment === "..") {
      fail("parent-directory segments are not allowed");
    }
    if (segment.toLowerCase() === ".git") {
      fail("git metadata cannot be materialized");
    }
    if (segment.includes(":") || /[. ]$/.test(segment) || isWindowsReservedSegment(segment)) {
      fail("path is not portable to Windows");
    }
  }

  return segments.join("/");
}

function isWindowsReservedSegment(segment: string): boolean {
  const basename = segment.split(".", 1)[0]?.toLowerCase() ?? "";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(basename);
}

export function getRecursiveDirectoryPath(entry: WorktreeIncludeEntry): string | null {
  const segments = entry.relativePath.split("/");
  if (
    segments.length < 2 ||
    segments.at(-1) !== "**" ||
    segments.slice(0, -1).some((segment) => segment.includes("*"))
  ) {
    return null;
  }
  return segments.slice(0, -1).join("/");
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}
