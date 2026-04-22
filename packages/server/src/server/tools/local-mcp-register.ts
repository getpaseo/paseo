// @ts-nocheck
/**
 * Registers the local filesystem / shell / git tools on an MCP server
 * so agents can call them. The tool logic lives in pure functions next
 * to their unit tests — this module is just the wiring layer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import { ensureValidJson } from "../json-utils.js";
import {
  grepProject,
  listDir,
  readFile,
  writeFile,
} from "./local-fs-tools.js";
import { runCommand } from "./local-shell-tools.js";
import {
  gitBlame,
  gitBranches,
  gitCheckout,
  gitDiff,
  gitLog,
  gitStash,
  gitStatus,
} from "./local-git-tools.js";

function errorResult(error: unknown, emptyShape: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    structuredContent: ensureValidJson(emptyShape),
    isError: true,
  };
}

export function registerLocalTools(server: McpServer, logger: Logger): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file from the agent's working directory. Returns UTF-8 text for text files, base64 for binaries. Content is truncated at maxBytes with `truncated: true` — the caller can request a larger limit if needed. Paths are scoped to `cwd`: `..` escapes are rejected.",
      inputSchema: {
        cwd: z.string().describe("Working directory the path is resolved against"),
        path: z.string().describe("Relative (preferred) or absolute path inside cwd"),
        maxBytes: z.number().int().positive().optional(),
      },
      outputSchema: {
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf-8", "base64"]),
        bytes: z.number(),
        truncated: z.boolean(),
      },
    },
    async ({ cwd, path, maxBytes }) => {
      try {
        const result = await readFile({ cwd, path, maxBytes });
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, cwd, path }, "read_file failed");
        return errorResult(error, {
          path,
          content: "",
          encoding: "utf-8",
          bytes: 0,
          truncated: false,
        });
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Write content to a file in the agent's working directory. Creates parent directories by default (pass `createDirs: false` to opt out). For binary content, set `encoding: 'base64'` and provide a base64-encoded string.",
      inputSchema: {
        cwd: z.string(),
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf-8", "base64"]).optional(),
        createDirs: z.boolean().optional(),
      },
      outputSchema: {
        path: z.string(),
        bytes: z.number(),
      },
    },
    async (args) => {
      try {
        const result = await writeFile(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, path: args.path }, "write_file failed");
        return errorResult(error, { path: args.path, bytes: 0 });
      }
    },
  );

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description:
        "List entries in a directory inside the agent's working directory. Returns type (file/dir/symlink) and size in bytes for files. Directories are listed before files, then sorted alphabetically.",
      inputSchema: {
        cwd: z.string(),
        path: z.string().optional(),
        hideHidden: z.boolean().optional(),
      },
      outputSchema: {
        path: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["file", "dir", "symlink", "other"]),
            size: z.number().nullable(),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const result = await listDir(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, path: args.path }, "list_dir failed");
        return errorResult(error, { path: args.path ?? ".", entries: [] });
      }
    },
  );

  server.registerTool(
    "grep_project",
    {
      title: "Search code (grep)",
      description:
        "Search for a pattern across files in the agent's working directory. Uses ripgrep when available (fast, respects .gitignore) and falls back to a JS walker that skips node_modules/.git/dist/build. Matches include file path, line number, and the matching line.",
      inputSchema: {
        cwd: z.string(),
        pattern: z.string(),
        path: z.string().optional(),
        caseSensitive: z.boolean().optional(),
        fixedString: z.boolean().optional(),
        glob: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
      },
      outputSchema: {
        matches: z.array(
          z.object({
            path: z.string(),
            lineNumber: z.number(),
            line: z.string(),
          }),
        ),
        truncated: z.boolean(),
        backend: z.enum(["ripgrep", "js"]),
      },
    },
    async (args) => {
      try {
        const result = await grepProject(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, pattern: args.pattern }, "grep_project failed");
        return errorResult(error, { matches: [], truncated: false, backend: "js" });
      }
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Run a one-shot shell command in the agent's working directory. Stdout and stderr are captured separately. Timeout is mandatory (default 30s, max 10min) — the process is SIGKILL'd if it exceeds it. For interactive sessions use `create_terminal` instead.",
      inputSchema: {
        cwd: z.string(),
        command: z.string().describe("Shell command to execute (sh -c)"),
        timeoutMs: z.number().int().positive().optional(),
        env: z.record(z.string()).optional(),
        maxBytes: z.number().int().positive().optional(),
      },
      outputSchema: {
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().nullable(),
        timedOut: z.boolean(),
        stdoutTruncated: z.boolean(),
        stderrTruncated: z.boolean(),
        durationMs: z.number(),
      },
    },
    async (args) => {
      try {
        const result = await runCommand(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, command: args.command }, "run_command failed");
        return errorResult(error, {
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
        });
      }
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description:
        "Structured git working-tree status (porcelain v1 parsed). Returns branch, upstream, ahead/behind counts, and an entry per changed file with its index and worktree status codes.",
      inputSchema: {
        cwd: z.string(),
      },
      outputSchema: {
        branch: z.string().nullable(),
        upstream: z.string().nullable(),
        ahead: z.number(),
        behind: z.number(),
        clean: z.boolean(),
        entries: z.array(
          z.object({
            worktree: z.string(),
            index: z.string(),
            path: z.string(),
            originalPath: z.string().optional(),
          }),
        ),
      },
    },
    async ({ cwd }) => {
      try {
        const result = await gitStatus({ cwd });
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, cwd }, "git_status failed");
        return errorResult(error, {
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          clean: true,
          entries: [],
        });
      }
    },
  );

  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description:
        "List commits in reverse chronological order. Each entry has full/short hash, author name+email, ISO date, subject, and body. Filter by `path`, `author` (substring), `since` (e.g. '2 weeks ago'), or `ref` (branch/tag/sha). Default limit 50.",
      inputSchema: {
        cwd: z.string(),
        maxCount: z.number().int().positive().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        ref: z.string().optional(),
      },
      outputSchema: {
        entries: z.array(
          z.object({
            hash: z.string(),
            shortHash: z.string(),
            author: z.string(),
            authorEmail: z.string(),
            date: z.string(),
            subject: z.string(),
            body: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const result = await gitLog(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, cwd: args.cwd }, "git_log failed");
        return errorResult(error, { entries: [] });
      }
    },
  );

  server.registerTool(
    "git_blame",
    {
      title: "Git blame",
      description:
        "Per-line authorship for a file. Each line carries the commit hash, author name, ISO date, and content. Optionally scope to a line range with `startLine`/`endLine`.",
      inputSchema: {
        cwd: z.string(),
        path: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
      outputSchema: {
        path: z.string(),
        lines: z.array(
          z.object({
            lineNumber: z.number(),
            hash: z.string(),
            shortHash: z.string(),
            author: z.string(),
            date: z.string(),
            content: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const result = await gitBlame(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, path: args.path }, "git_blame failed");
        return errorResult(error, { path: args.path, lines: [] });
      }
    },
  );

  server.registerTool(
    "git_branches",
    {
      title: "List git branches",
      description:
        "List local branches (and optionally remote-tracking) with current marker, upstream, tip short-hash, and tip commit subject.",
      inputSchema: {
        cwd: z.string(),
        includeRemote: z.boolean().optional(),
      },
      outputSchema: {
        branches: z.array(
          z.object({
            name: z.string(),
            current: z.boolean(),
            remote: z.boolean(),
            upstream: z.string().nullable(),
            tipHash: z.string().nullable(),
            tipSubject: z.string().nullable(),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const result = await gitBranches(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, cwd: args.cwd }, "git_branches failed");
        return errorResult(error, { branches: [] });
      }
    },
  );

  server.registerTool(
    "git_checkout",
    {
      title: "Git checkout",
      description:
        "Switch to a branch. Pass `create: true` to create a new branch (optionally with `startPoint`). Fails if the working tree has conflicting changes — the error message surfaces git's reason.",
      inputSchema: {
        cwd: z.string(),
        branch: z.string(),
        create: z.boolean().optional(),
        startPoint: z.string().optional(),
      },
      outputSchema: {
        branch: z.string(),
        created: z.boolean(),
        previous: z.string().nullable(),
      },
    },
    async (args) => {
      try {
        const result = await gitCheckout(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, branch: args.branch }, "git_checkout failed");
        return errorResult(error, {
          branch: args.branch,
          created: false,
          previous: null,
        });
      }
    },
  );

  server.registerTool(
    "git_stash",
    {
      title: "Git stash",
      description:
        "Stash operations: `list` (show all stashes), `save` (push current changes, optional `message` and `includeUntracked`), `pop`/`apply`/`drop` (optionally target a specific `ref` like 'stash@{2}'; defaults to 'stash@{0}').",
      inputSchema: {
        cwd: z.string(),
        action: z.enum(["list", "save", "pop", "drop", "apply"]),
        message: z.string().optional(),
        ref: z.string().optional(),
        includeUntracked: z.boolean().optional(),
      },
      outputSchema: {
        action: z.enum(["list", "save", "pop", "drop", "apply"]),
        entries: z
          .array(
            z.object({
              ref: z.string(),
              subject: z.string(),
            }),
          )
          .optional(),
        message: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await gitStash(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, action: args.action }, "git_stash failed");
        return errorResult(error, { action: args.action });
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Unified diff of changes in the working tree. Pass `staged: true` for staged changes. Optionally scope to a `path` and set context-line count. Output is truncated at `maxBytes` with `truncated: true` flagged.",
      inputSchema: {
        cwd: z.string(),
        staged: z.boolean().optional(),
        path: z.string().optional(),
        contextLines: z.number().int().min(0).optional(),
        maxBytes: z.number().int().positive().optional(),
      },
      outputSchema: {
        diff: z.string(),
        truncated: z.boolean(),
        bytes: z.number(),
      },
    },
    async (args) => {
      try {
        const result = await gitDiff(args);
        return { content: [], structuredContent: ensureValidJson(result) };
      } catch (error) {
        logger.error({ error, cwd: args.cwd }, "git_diff failed");
        return errorResult(error, { diff: "", truncated: false, bytes: 0 });
      }
    },
  );
}
