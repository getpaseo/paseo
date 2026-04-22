/**
 * Local filesystem MCP tools — read/write/list/grep, scoped to a cwd.
 *
 * Design: pure functions that take a `cwd` + params and return a plain
 * object. Keeping the tool logic separate from the MCP registration
 * wrapper means the same code can be exercised by unit tests against a
 * real temp dir (no mocks), then a thin `registerLocalFsTools` in
 * `local-mcp-register.ts` exposes them to agents.
 *
 * Path safety: every request is resolved inside `cwd` and rejected if
 * it escapes via `..`. Absolute paths are allowed as long as they land
 * inside `cwd`. This is a first line of defense — the real permission
 * model still lives in the agent provider's sandboxing.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface ReadFileInput {
  cwd: string;
  path: string;
  /** Max bytes to return. Content past this is truncated and the
   * `truncated` flag is set so the caller can tell it wasn't the whole
   * file. Default 1 MiB — enough for source files, cheap for the wire. */
  maxBytes?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  bytes: number;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Resolve `p` against `cwd` and throw if the result escapes `cwd`. */
export function resolveInsideCwd(cwd: string, p: string): string {
  const absCwd = path.resolve(cwd);
  const target = path.resolve(absCwd, p);
  const rel = path.relative(absCwd, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path escapes cwd: ${p} (resolved to ${target}, cwd is ${absCwd})`,
    );
  }
  return target;
}

/** Best-effort binary detection: a NUL byte in the first chunk means binary.
 * Source code on every platform we care about is UTF-8, so this keeps text
 * files readable and quietly switches to base64 for binaries instead of
 * emitting a garbled string. */
function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8000, buf.length));
  return sample.includes(0);
}

export async function readFile(input: ReadFileInput): Promise<ReadFileResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const abs = resolveInsideCwd(input.cwd, input.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${input.path}`);
  }
  const raw = await fs.readFile(abs);
  const truncated = raw.length > maxBytes;
  const buf = truncated ? raw.subarray(0, maxBytes) : raw;
  const binary = isProbablyBinary(buf);
  return {
    path: path.relative(path.resolve(input.cwd), abs),
    content: binary ? buf.toString("base64") : buf.toString("utf-8"),
    encoding: binary ? "base64" : "utf-8",
    bytes: raw.length,
    truncated,
  };
}

export interface WriteFileInput {
  cwd: string;
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
  /** Create parent dirs if missing, like `mkdir -p`. Default true —
   * writing to a path whose dir doesn't exist is almost always a mistake
   * the caller wants auto-fixed, and if they didn't they'd have hit the
   * error on the first attempt. */
  createDirs?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

export async function writeFile(input: WriteFileInput): Promise<WriteFileResult> {
  const abs = resolveInsideCwd(input.cwd, input.path);
  if ((input.createDirs ?? true)) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }
  const buf =
    input.encoding === "base64"
      ? Buffer.from(input.content, "base64")
      : Buffer.from(input.content, "utf-8");
  await fs.writeFile(abs, buf);
  return {
    path: path.relative(path.resolve(input.cwd), abs),
    bytes: buf.length,
  };
}

export interface ListDirInput {
  cwd: string;
  path?: string;
  /** Hide dotfiles (entries starting with `.`). Default false. */
  hideHidden?: boolean;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
}

export async function listDir(input: ListDirInput): Promise<ListDirResult> {
  const abs = resolveInsideCwd(input.cwd, input.path ?? ".");
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${input.path ?? "."}`);
  }
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (input.hideHidden && d.name.startsWith(".")) continue;
    let type: DirEntry["type"] = "other";
    let size: number | null = null;
    if (d.isFile()) {
      type = "file";
      try {
        const s = await fs.stat(path.join(abs, d.name));
        size = s.size;
      } catch {
        // file disappeared between readdir and stat — skip size
      }
    } else if (d.isDirectory()) {
      type = "dir";
    } else if (d.isSymbolicLink()) {
      type = "symlink";
    }
    entries.push({ name: d.name, type, size });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      // dirs first, then files, then symlinks/other — matches common UIs
      const order = { dir: 0, file: 1, symlink: 2, other: 3 } as const;
      return order[a.type] - order[b.type];
    }
    return a.name.localeCompare(b.name);
  });
  return {
    path: path.relative(path.resolve(input.cwd), abs) || ".",
    entries,
  };
}

export interface GrepProjectInput {
  cwd: string;
  pattern: string;
  /** Subpath inside cwd to scope the search. Default: whole cwd. */
  path?: string;
  caseSensitive?: boolean;
  /** Treat `pattern` as a fixed string (rg -F), not a regex. Default false. */
  fixedString?: boolean;
  /** Max matches to return. Extra matches are dropped. Default 200. */
  maxResults?: number;
  /** File glob to filter (rg --glob). E.g. "*.ts". Optional. */
  glob?: string;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface GrepProjectResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** Which backend ran the search. `ripgrep` is preferred when present. */
  backend: "ripgrep" | "js";
}

const DEFAULT_MAX_RESULTS = 200;

/**
 * Search the project using ripgrep if available, else a JS walker.
 *
 * ripgrep is an order of magnitude faster on large repos and respects
 * `.gitignore` out of the box. The JS fallback exists so tests and small
 * environments (containers without rg) still work.
 */
export async function grepProject(input: GrepProjectInput): Promise<GrepProjectResult> {
  const scope = resolveInsideCwd(input.cwd, input.path ?? ".");
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (await hasRipgrep()) {
    return runRipgrep({ ...input, scope, maxResults });
  }
  return runJsGrep({ ...input, scope, maxResults });
}

let ripgrepCache: boolean | null = null;
async function hasRipgrep(): Promise<boolean> {
  if (ripgrepCache !== null) return ripgrepCache;
  ripgrepCache = await new Promise<boolean>((resolve) => {
    const p = spawn("rg", ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  return ripgrepCache;
}

/** Reset the ripgrep-availability cache — only used from tests that want
 * to force the JS fallback path. */
export function __resetRipgrepCacheForTests(): void {
  ripgrepCache = null;
}

/** Force a specific backend from tests. Pass `null` to revert to
 * auto-detection. */
export function __setRipgrepOverrideForTests(override: boolean | null): void {
  ripgrepCache = override;
}

async function runRipgrep(
  input: GrepProjectInput & { scope: string; maxResults: number },
): Promise<GrepProjectResult> {
  const args = ["--json", "--max-count", String(input.maxResults)];
  if (!input.caseSensitive) args.push("-i");
  if (input.fixedString) args.push("-F");
  if (input.glob) args.push("--glob", input.glob);
  args.push("--", input.pattern, input.scope);
  return new Promise<GrepProjectResult>((resolve, reject) => {
    const matches: GrepMatch[] = [];
    let stdout = "";
    let stderr = "";
    const p = spawn("rg", args);
    p.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("close", (code) => {
      // rg returns 1 when no match — not an error.
      if (code !== 0 && code !== 1) {
        reject(new Error(`ripgrep exited ${code}: ${stderr}`));
        return;
      }
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type !== "match") continue;
          const rel = path.relative(
            path.resolve(input.cwd),
            evt.data.path.text,
          );
          matches.push({
            path: rel,
            lineNumber: evt.data.line_number,
            line: (evt.data.lines.text as string).replace(/\n$/, ""),
          });
          if (matches.length >= input.maxResults) break;
        } catch {
          // ignore malformed lines
        }
      }
      resolve({
        matches,
        truncated: matches.length >= input.maxResults,
        backend: "ripgrep",
      });
    });
    p.on("error", reject);
  });
}

async function runJsGrep(
  input: GrepProjectInput & { scope: string; maxResults: number },
): Promise<GrepProjectResult> {
  const matches: GrepMatch[] = [];
  const flags = input.caseSensitive ? "" : "i";
  const re = input.fixedString
    ? null
    : new RegExp(input.pattern, flags);
  const needle = input.caseSensitive
    ? input.pattern
    : input.pattern.toLowerCase();

  const isMatch = (text: string): boolean => {
    if (re) return re.test(text);
    return (input.caseSensitive ? text : text.toLowerCase()).includes(needle);
  };

  // Common dirs we always skip — avoids crawling into node_modules on
  // every call, which would make even a small repo slow.
  const skip = new Set([".git", "node_modules", ".next", "dist", "build"]);

  async function walk(dir: string): Promise<void> {
    if (matches.length >= input.maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (matches.length >= input.maxResults) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (input.glob) {
        const g = input.glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
        if (!new RegExp(`^${g}$`).test(e.name)) continue;
      }
      let content: string;
      try {
        const buf = await fs.readFile(full);
        if (isProbablyBinary(buf)) continue;
        content = buf.toString("utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= input.maxResults) break;
        if (isMatch(lines[i]!)) {
          matches.push({
            path: path.relative(path.resolve(input.cwd), full),
            lineNumber: i + 1,
            line: lines[i]!,
          });
        }
      }
    }
  }

  const stat = await fs.stat(input.scope);
  if (stat.isDirectory()) {
    await walk(input.scope);
  } else if (stat.isFile()) {
    // Scope is a single file — just search it.
    const buf = await fs.readFile(input.scope);
    if (!isProbablyBinary(buf)) {
      const lines = buf.toString("utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= input.maxResults) break;
        if (isMatch(lines[i]!)) {
          matches.push({
            path: path.relative(path.resolve(input.cwd), input.scope),
            lineNumber: i + 1,
            line: lines[i]!,
          });
        }
      }
    }
  }
  return {
    matches,
    truncated: matches.length >= input.maxResults,
    backend: "js",
  };
}
