#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook — emits a short suggestion pointing the agent
 * at faster `crg_*` alternatives when it used Read/Grep/Glob on what looks
 * like an exploratory question.
 *
 * Registered by Hubcode's indexing service into `~/.claude/settings.json`
 * whenever at least one workspace has indexing enabled. Unregistered when
 * the last workspace opts out or `code-review-graph` is uninstalled.
 *
 * Hook protocol (Claude Code):
 *   - stdin:  JSON { tool_name, tool_input, tool_response, cwd, ... }
 *   - stdout: JSON { hookSpecificOutput: { hookEventName, additionalContext } }
 *   - stderr: only user-facing diagnostics; never log noise during happy path
 *
 * Design goals:
 *   - Zero deps. Runs via plain `node`, lives beside bundled dist.
 *   - Fast: <50ms wall time on the happy path. Claude Code times hooks.
 *   - Silent when not useful: only emits a hint past a threshold, and never
 *     when the file is obviously edit-bound (tool_input has `offset`, a
 *     strong signal the agent's paginating for a known reason).
 *   - Self-suggesting: the hint embeds the actual file_path / query so the
 *     agent can copy-paste the suggested crg_* call directly.
 */

const LARGE_FILE_LINES = 500;
const MANY_GREP_MATCHES = 20;
const MANY_GLOB_ENTRIES = 100;

// ---------------------------------------------------------------------------

// Never propagate failures to Claude Code — better to produce no hint than
// to surface a "hook error" banner on every Read/Grep/Glob. We silence both
// unhandled exceptions and unhandled promise rejections, and wrap stdin
// plumbing in try/catch.
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate the whole hook on the CWD actually having a code-review-graph
 * index. The hook is registered in `~/.claude/settings.json` (user-global),
 * so Claude Code fires it on every project — not just hubcode-indexed
 * workspaces. Bail fast when the suggestion would be meaningless.
 */
function isIndexedWorkspace(cwd) {
  if (!cwd || typeof cwd !== "string") return false;
  return existsSync(join(cwd, ".code-review-graph"));
}

try {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
  });
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(buf || "{}");
      if (!isIndexedWorkspace(payload?.cwd)) {
        process.exit(0);
      }
      const hint = suggest(payload);
      if (hint) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: hint,
            },
          }),
        );
      }
    } catch {
      // Silence > noise.
    }
    process.exit(0);
  });
} catch {
  process.exit(0);
}

// ---------------------------------------------------------------------------

function suggest(p) {
  const toolName = p?.tool_name;
  if (!toolName) return null;
  const input = p.tool_input ?? {};
  const response = p.tool_response;
  const text = normalizeResponseText(response);

  if (toolName === "Read") {
    if (typeof input.offset === "number" && input.offset > 0) return null; // intentional paging
    const filePath = input.file_path || "<path>";
    // "File too large" errors are the *strongest* signal to steer at crg —
    // Read literally cannot handle the file in one shot. Match common Claude
    // Code error phrasings.
    if (looksLikeTooLargeError(text)) {
      return (
        `📊 Read failed (file too large to inline). ` +
        `\`crg_get_minimal_context(repo_root="${escapeArg(p.cwd ?? "")}", file_path="${escapeArg(filePath)}")\` ` +
        `returns signatures + callers in ~100 tokens regardless of file size. ` +
        `Use Read with \`offset\`/\`limit\` only if you need unique raw content.`
      );
    }
    const lines = countLines(text);
    if (lines <= LARGE_FILE_LINES) return null;
    return (
      `📊 Read returned ${lines.toLocaleString()} lines. ` +
      `For structural questions (callers, dependencies, impact), ` +
      `\`crg_get_minimal_context(repo_root="${escapeArg(p.cwd ?? "")}", file_path="${escapeArg(filePath)}")\` ` +
      `returns signatures + callers in ~100 tokens. ` +
      `Keep Read for editing or unique content.`
    );
  }

  if (toolName === "Grep") {
    const matches = countGrepMatches(text);
    if (matches <= MANY_GREP_MATCHES) return null;
    const pattern = input.pattern ?? input.regex ?? "<query>";
    return (
      `🔎 Grep returned ${matches.toLocaleString()} matches for "${escapeArg(pattern)}". ` +
      `For concept-based searches, ` +
      `\`crg_semantic_search_nodes(repo_root="${escapeArg(p.cwd ?? "")}", query="${escapeArg(pattern)}")\` ` +
      `ranks by semantic similarity instead of string overlap, usually with far fewer false positives.`
    );
  }

  if (toolName === "Glob") {
    const entries = countLines(text);
    if (entries <= MANY_GLOB_ENTRIES) return null;
    const pattern = String(input.pattern ?? "");
    // Only hint when the pattern looks like a whole-tree *code* sweep. For
    // file-ops intent ("list all .md", "find configs"), crg is the wrong
    // answer and the hint would be misleading.
    if (!isExploratoryCodeGlob(pattern)) return null;
    return (
      `📁 Glob("${escapeArg(pattern)}") returned ${entries.toLocaleString()} paths — looks like a ` +
      `whole-tree code sweep. If the goal is to understand structure (entry points, hubs, impact) ` +
      `rather than enumerate files, \`crg_get_architecture_overview\` / \`crg_get_hub_nodes\` ` +
      `return ranked summaries directly. If you actually need the file list, ignore this.`
    );
  }

  return null;
}

function normalizeResponseText(resp) {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp === "object") {
    // Common shapes across Claude Code tool responses.
    if (typeof resp.content === "string") return resp.content;
    if (typeof resp.text === "string") return resp.text;
    if (Array.isArray(resp.content)) {
      return resp.content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n");
    }
    try {
      return JSON.stringify(resp);
    } catch {
      return "";
    }
  }
  return String(resp);
}

function looksLikeTooLargeError(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    (t.includes("too large") || t.includes("exceeds") || t.includes("maximum")) &&
    (t.includes("token") || t.includes("line") || t.includes("file"))
  );
}

function countLines(s) {
  if (!s) return 0;
  // `+1` for the last line without a trailing newline — matches `wc -l`
  // semantics for terminal-output-style content.
  return (s.match(/\n/g) || []).length + 1;
}

function countGrepMatches(text) {
  if (!text) return 0;
  // Claude Code's Grep returns matches in several formats. The cheapest
  // universal proxy: non-empty lines. This under-counts grouped output but
  // never over-counts, so the threshold never fires spuriously.
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) n += 1;
  }
  return n;
}

// Code extensions for which a whole-tree glob is almost always exploratory.
// Deliberately excludes config/doc/data formats (md, json, yaml, toml, lock,
// csv, svg, png, …) where Glob is the right tool and crg doesn't apply.
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "rb",
  "php",
  "cpp",
  "cc",
  "cxx",
  "c",
  "h",
  "hpp",
  "cs",
  "scala",
  "dart",
  "lua",
  "zig",
]);

function isExploratoryCodeGlob(pattern) {
  if (!pattern) return false;
  // Must span the tree — single-directory globs like `src/*.ts` are usually
  // targeted edits, not exploration.
  if (!pattern.includes("**")) return false;
  // "Everything" patterns are exploratory regardless of extension.
  if (/^\*\*\/\*+$/.test(pattern)) return true;
  // Extract ext(s) — supports `**/*.ts` and `**/*.{ts,tsx}`.
  const braceMatch = pattern.match(/\{([^}]+)\}$/);
  if (braceMatch) {
    return braceMatch[1]
      .split(",")
      .map((e) => e.trim().replace(/^\./, ""))
      .some((e) => CODE_EXTS.has(e.toLowerCase()));
  }
  const dotMatch = pattern.match(/\.([a-zA-Z0-9]+)$/);
  if (dotMatch) return CODE_EXTS.has(dotMatch[1].toLowerCase());
  return false;
}

function escapeArg(v) {
  // The hint is quoted with `"` in the suggestion; escape backslashes and
  // quotes so the copy-pasted command stays valid.
  return String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
