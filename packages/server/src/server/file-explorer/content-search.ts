import { promises as fs, statSync as fsSyncStat, readFileSync as fsSyncRead } from "fs";
import path from "path";
import { runGitCommand } from "../../utils/run-git-command.js";
import type { ContentSearchFile, ContentSearchMatch } from "@getpaseo/protocol/messages";

/**
 * VSCode-style fixed-string, case-insensitive content search under a cwd.
 * Uses `git grep` inside git repos (respects .gitignore, skips binaries,
 * includes untracked files); falls back to a bounded walk for non-git
 * directories. Results are grouped per file with a total match cap.
 */

const MAX_MATCHES = 500;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

// Walk fallback bounds
const MAX_WALK_DEPTH = 8;
const MAX_WALKED_FILES = 20_000;
const MAX_FILE_BYTES = 512 * 1024;

const IGNORED_ENTRY_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);

export class ContentSearchQueryError extends Error {}

export interface ContentSearchResult {
  files: ContentSearchFile[];
  truncated: boolean;
}

interface RawMatch {
  relPath: string;
  match: ContentSearchMatch;
}

/**
 * Parse one `git grep -n` output line: `relPath:lineNo:text`. File names may
 * contain ':' on exotic systems, so scan colon positions until the remainder
 * starts with digits + ':'.
 */
export function parseGitGrepLine(line: string): RawMatch | null {
  let idx = -1;
  while ((idx = line.indexOf(":", idx + 1)) !== -1) {
    const rest = line.slice(idx + 1);
    const colon = rest.indexOf(":");
    if (colon > 0 && /^\d+$/.test(rest.slice(0, colon))) {
      return {
        relPath: line.slice(0, idx),
        match: {
          line: parseInt(rest.slice(0, colon), 10),
          text: rest.slice(colon + 1),
        },
      };
    }
  }
  return null;
}

function groupMatches(matches: RawMatch[]): ContentSearchResult {
  const files: ContentSearchFile[] = [];
  const byPath = new Map<string, ContentSearchFile>();
  for (const { relPath, match } of matches) {
    let file = byPath.get(relPath);
    if (!file) {
      file = { relPath, matches: [] };
      byPath.set(relPath, file);
      files.push(file);
    }
    file.matches.push(match);
  }
  return { files, truncated: false };
}

/**
 * Fixed-string case-insensitive git grep. Returns null when the cwd is not a
 * git repo (or git fails) so the caller falls back to the walk.
 * Note: git grep has no per-file match limit switch (-m is GNU grep only);
 * the cap is applied while collecting results.
 */
async function searchWithGit(cwd: string, query: string): Promise<ContentSearchResult | null> {
  let stdout: string;
  try {
    const result = await runGitCommand(
      ["grep", "-n", "-I", "-i", "-F", "--untracked", "-e", query],
      { cwd, acceptExitCodes: [0, 1] },
    );
    stdout = result.stdout;
  } catch {
    return null; // not a repo / git unavailable → caller falls back to walk
  }

  const collected: RawMatch[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    const parsed = parseGitGrepLine(rawLine);
    if (!parsed) continue;
    collected.push(parsed);
    if (collected.length >= MAX_MATCHES) {
      return { ...groupMatches(collected), truncated: true };
    }
  }
  return groupMatches(collected);
}

function collectFileMatches(
  absFile: string,
  childRel: string,
  lowerQuery: string,
  collected: RawMatch[],
): void {
  let content: string;
  try {
    // statSync-style guard via fs.promises stat; oversized files are skipped
    // without reading them.
    const info = fsSyncStat(absFile);
    if (info.size > MAX_FILE_BYTES) return;
    content = fsSyncRead(absFile, "utf8");
  } catch {
    return;
  }
  if (content.includes("\0")) return; // binary
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      collected.push({
        relPath: childRel,
        match: { line: i + 1, text: lines[i].slice(0, 400) },
      });
      if (collected.length >= MAX_MATCHES) return;
    }
  }
}

async function searchWithWalk(cwd: string, lowerQuery: string): Promise<ContentSearchResult> {
  const collected: RawMatch[] = [];
  let walked = 0;
  let truncated = false;

  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: cwd, rel: "", depth: 0 },
  ];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_ENTRY_NAMES.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (walked >= MAX_WALKED_FILES || collected.length >= MAX_MATCHES) {
        truncated = true;
        return { ...groupMatches(collected), truncated };
      }
      walked += 1;
      collectFileMatches(path.join(abs, entry.name), childRel, lowerQuery, collected);
      if (collected.length >= MAX_MATCHES) {
        return { ...groupMatches(collected), truncated: true };
      }
    }
  }
  return { ...groupMatches(collected), truncated };
}

export async function searchFileContents(cwd: string, query: string): Promise<ContentSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH || trimmed.length > MAX_QUERY_LENGTH) {
    throw new ContentSearchQueryError(
      `Query must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters`,
    );
  }

  const viaGit = await searchWithGit(cwd, trimmed);
  if (viaGit !== null) {
    return viaGit;
  }
  return searchWithWalk(cwd, trimmed.toLowerCase());
}
