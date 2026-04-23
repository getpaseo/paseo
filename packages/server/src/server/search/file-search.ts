import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Fuzzy file search across workspace trees. Walks each workspace root with a
 * capped breadth-first traversal, skips `.git`, `node_modules`, and common
 * build artifacts, and returns the top N paths whose basename or path
 * contains every whitespace-separated token of the query.
 *
 * Not backed by an index — fine for repos up to ~50k files because:
 *   - breadth-first + per-dir entry sorting means hits in shallow
 *     directories surface first,
 *   - per-workspace and global caps short-circuit deep trees early,
 *   - the caller debounces queries (~250ms) before calling us.
 *
 * For larger monorepos we'll want `ripgrep --files` + a persisted manifest;
 * this is the simple-correct starting point.
 */

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "target",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".expo",
  ".vercel",
  "coverage",
]);

/** Stop scanning a single workspace after this many files regardless of matches. */
const PER_WORKSPACE_FILE_CAP = 20_000;
/** Hard wall on directory depth to avoid pathological symlink loops. */
const MAX_DEPTH = 20;

export interface FileSearchWorkspace {
  workspaceId: string;
  workspaceName?: string;
  cwd: string;
}

export interface FileSearchMatch {
  workspaceId: string;
  workspaceName?: string;
  relativePath: string;
  /**
   * Lower = better. Used to merge + rank across workspaces.
   */
  score: number;
}

export interface FileSearchOptions {
  query: string;
  limit: number;
  workspaces: FileSearchWorkspace[];
}

export interface FileSearchResult {
  matches: FileSearchMatch[];
  truncated: boolean;
}

export async function searchFiles(options: FileSearchOptions): Promise<FileSearchResult> {
  const tokens = options.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { matches: [], truncated: false };

  const all: FileSearchMatch[] = [];
  let truncated = false;

  await Promise.all(
    options.workspaces.map(async (ws) => {
      const stats = await fs.stat(ws.cwd).catch(() => null);
      if (!stats || !stats.isDirectory()) return;

      const perWorkspace: FileSearchMatch[] = [];
      const walker = walkBfs(ws.cwd, PER_WORKSPACE_FILE_CAP, MAX_DEPTH);
      for await (const relativePath of walker) {
        const score = matchScore(relativePath, tokens);
        if (score === -1) continue;
        perWorkspace.push({
          workspaceId: ws.workspaceId,
          workspaceName: ws.workspaceName,
          relativePath,
          score,
        });
        // Cap per-workspace early — surfaces "some results from every
        // workspace" instead of blowing the budget on the first one.
        if (perWorkspace.length >= Math.max(10, Math.ceil(options.limit / 2))) break;
      }
      all.push(...perWorkspace);
    }),
  );

  all.sort((a, b) => a.score - b.score || a.relativePath.localeCompare(b.relativePath));
  if (all.length > options.limit) {
    truncated = true;
    all.length = options.limit;
  }
  return { matches: all, truncated };
}

/**
 * Score a path against a set of lowercase tokens. Returns -1 when any token
 * is absent. Otherwise lower is better:
 *   - basename match worth a big bonus
 *   - contiguous match worth a small bonus
 *   - shorter paths win ties
 */
function matchScore(relativePath: string, tokens: string[]): number {
  const lowered = relativePath.toLowerCase();
  const base = lowered.substring(lowered.lastIndexOf("/") + 1);
  let score = relativePath.length;
  for (const tok of tokens) {
    const inBase = base.indexOf(tok);
    if (inBase >= 0) {
      score -= 200 - inBase * 4;
      continue;
    }
    const inPath = lowered.indexOf(tok);
    if (inPath < 0) return -1;
    score -= 40 - Math.min(40, inPath);
  }
  return score;
}

async function* walkBfs(root: string, fileCap: number, maxDepth: number): AsyncGenerator<string> {
  interface QueueEntry {
    dir: string;
    depth: number;
  }
  const queue: QueueEntry[] = [{ dir: root, depth: 0 }];
  let filesSeen = 0;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(dir, {
        withFileTypes: true,
      })) as unknown as import("node:fs").Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") {
        if (IGNORED_DIRS.has(entry.name)) continue;
        // Skip dotfiles in search results — rarely what the user wants. Keep
        // the few that are routinely edited.
        if (entry.isFile()) continue;
      }
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: absolute, depth: depth + 1 });
      } else if (entry.isFile()) {
        filesSeen++;
        if (filesSeen > fileCap) return;
        yield path.relative(root, absolute);
      }
    }
  }
}
