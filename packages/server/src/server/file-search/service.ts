import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  FileSearchMatch,
  FileSearchRequest,
  FileSearchResponse,
} from "@getpaseo/protocol/messages";
import { spawnProcess } from "../../utils/spawn.js";

const DEFAULT_MAX_RESULTS = 2000;
const MAX_MATCHES_PER_FILE = 100;
const MAX_LINE_CONTENT_LENGTH = 500;
const MAX_STDOUT_LINE_LENGTH = 256 * 1024;
const MAX_STDERR_LENGTH = 4096;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_MAX_FILE_SIZE_MB = 5;
const SEARCH_MAX_COLUMNS = 10_000;

type SearchInput = Omit<FileSearchRequest, "type" | "requestId"> & { signal?: AbortSignal };
type SearchResult = Pick<FileSearchResponse["payload"], "files" | "totalMatches" | "truncated">;

export interface SearchCommand {
  command: "rg" | "git";
  args: string[];
  cwd: string;
  signal: AbortSignal;
  onStdoutLine(line: string): void;
}

export interface SearchCommandResult {
  exitCode: number | null;
  stderr: string;
}

export interface SearchCommandRunner {
  run(command: SearchCommand): Promise<SearchCommandResult>;
}

export interface SearchWorkspaceFilesOptions {
  runner?: SearchCommandRunner;
  timeoutMs?: number;
}

export class WorkspaceFileSearchError extends Error {
  readonly code: "cancelled" | "command_failed" | "invalid_workspace" | "timeout";

  constructor(code: WorkspaceFileSearchError["code"], message: string) {
    super(message);
    this.name = "WorkspaceFileSearchError";
    this.code = code;
  }
}

interface SearchAccumulator {
  files: Map<string, FileSearchMatch[]>;
  totalMatches: number;
  truncated: boolean;
  maxResults: number;
}

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  includePattern?: string;
  excludePattern?: string;
}

interface SearchRunState {
  controller: AbortController;
  stopReason: "limit" | "timeout" | "cancelled" | null;
}

const defaultSearchCommandRunner: SearchCommandRunner = {
  run: runSearchCommand,
};

export async function searchWorkspaceFiles(
  input: SearchInput,
  options: SearchWorkspaceFilesOptions = {},
): Promise<SearchResult> {
  if (input.signal?.aborted) throw new WorkspaceFileSearchError("cancelled", "Search cancelled");

  const cwd = await resolveWorkspaceRoot(input.cwd);
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const searchOptions: SearchOptions = {
    caseSensitive: input.caseSensitive ?? false,
    wholeWord: input.wholeWord ?? false,
    useRegex: input.useRegex ?? false,
    ...(input.includePattern ? { includePattern: input.includePattern } : {}),
    ...(input.excludePattern ? { excludePattern: input.excludePattern } : {}),
  };
  const accumulator: SearchAccumulator = {
    files: new Map(),
    totalMatches: 0,
    truncated: false,
    maxResults,
  };
  const state: SearchRunState = { controller: new AbortController(), stopReason: null };
  const abortFromCaller = function abortFromCaller(): void {
    stopSearch(state, "cancelled");
  };
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => stopSearch(state, "timeout"),
    options.timeoutMs ?? SEARCH_TIMEOUT_MS,
  );

  try {
    const commandResult = await runPreferredSearchCommand({
      input,
      cwd,
      searchOptions,
      accumulator,
      state,
      runner: options.runner ?? defaultSearchCommandRunner,
    });
    validateSearchCompletion(commandResult, state.stopReason);
    return {
      files: Array.from(accumulator.files, ([filePath, matches]) => ({ path: filePath, matches })),
      totalMatches: accumulator.totalMatches,
      truncated: accumulator.truncated,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function runPreferredSearchCommand(params: {
  input: SearchInput;
  cwd: string;
  searchOptions: SearchOptions;
  accumulator: SearchAccumulator;
  state: SearchRunState;
  runner: SearchCommandRunner;
}): Promise<SearchCommandResult> {
  const rgCommand: SearchCommand = {
    command: "rg",
    args: buildRipgrepArgs(params.input.query, params.searchOptions),
    cwd: params.cwd,
    signal: params.state.controller.signal,
    onStdoutLine(line) {
      if (ingestRipgrepLine(line, params.cwd, params.accumulator) === "stop") {
        stopSearch(params.state, "limit");
      }
    },
  };
  try {
    return await params.runner.run(rgCommand);
  } catch (error) {
    if (!isCommandMissingError(error)) throw error;
    if (params.state.stopReason) return { exitCode: null, stderr: "" };
    return params.runner.run({
      command: "git",
      args: buildGitGrepArgs(params.input.query, params.searchOptions),
      cwd: params.cwd,
      signal: params.state.controller.signal,
      onStdoutLine(line) {
        const outcome = ingestGitGrepLine(
          line,
          params.cwd,
          params.input.query,
          params.searchOptions,
          params.accumulator,
        );
        if (outcome === "stop") stopSearch(params.state, "limit");
      },
    });
  }
}

function stopSearch(
  state: SearchRunState,
  reason: NonNullable<SearchRunState["stopReason"]>,
): void {
  if (state.stopReason) return;
  state.stopReason = reason;
  state.controller.abort();
}

function validateSearchCompletion(
  commandResult: SearchCommandResult,
  stopReason: SearchRunState["stopReason"],
): void {
  if (stopReason === "cancelled") {
    throw new WorkspaceFileSearchError("cancelled", "Search cancelled");
  }
  if (stopReason === "timeout") {
    throw new WorkspaceFileSearchError("timeout", "Search timed out");
  }
  const commandSucceeded = commandResult.exitCode === 0 || commandResult.exitCode === 1;
  if (stopReason === "limit" || commandSucceeded) return;
  const detail = commandResult.stderr.trim();
  const message = detail ? `Search command failed: ${detail}` : "Search command failed";
  throw new WorkspaceFileSearchError("command_failed", message);
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    if (!path.isAbsolute(cwd)) throw new Error("not absolute");
    const root = await fs.realpath(cwd);
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) throw new Error("not a directory");
    return root;
  } catch {
    throw new WorkspaceFileSearchError("invalid_workspace", "Workspace root is not a directory");
  }
}

function buildRipgrepArgs(query: string, options: SearchOptions): string[] {
  const args = [
    "--json",
    "--hidden",
    "--glob",
    "!.git",
    "--max-count",
    String(MAX_MATCHES_PER_FILE + 1),
    "--max-filesize",
    `${SEARCH_MAX_FILE_SIZE_MB}M`,
    "--max-columns",
    String(SEARCH_MAX_COLUMNS),
  ];
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  if (!options.useRegex) args.push("--fixed-strings");
  appendRipgrepGlobs(args, options.includePattern, false);
  appendRipgrepGlobs(args, options.excludePattern, true);
  args.push("--", query, ".");
  return args;
}

function appendRipgrepGlobs(args: string[], patterns: string | undefined, exclude: boolean): void {
  if (!patterns) return;
  for (const pattern of splitGlobPatterns(patterns)) {
    args.push("--glob", exclude ? `!${pattern}` : pattern);
  }
}

function buildGitGrepArgs(query: string, options: SearchOptions): string[] {
  const args = [
    "-c",
    "submodule.recurse=false",
    "grep",
    "-n",
    "--column",
    "-I",
    "--null",
    "--no-color",
    "--untracked",
    "--no-recurse-submodules",
  ];
  if (!options.caseSensitive) args.push("-i");
  if (options.wholeWord) args.push("-w");
  args.push(options.useRegex ? "--extended-regexp" : "--fixed-strings", "-e", query, "--");
  const pathspecs = buildGitPathspecs(options);
  args.push(...(pathspecs.length > 0 ? pathspecs : ["."]));
  return args;
}

function buildGitPathspecs(options: SearchOptions): string[] {
  const pathspecs: string[] = [];
  for (const pattern of splitGlobPatterns(options.includePattern ?? "")) {
    const recursivePattern = pattern.includes("/") ? pattern : `**/${pattern}`;
    pathspecs.push(`:(glob)${recursivePattern}`);
  }
  for (const pattern of splitGlobPatterns(options.excludePattern ?? "")) {
    const recursivePattern = pattern.includes("/") ? pattern : `**/${pattern}`;
    pathspecs.push(`:(exclude,glob)${recursivePattern}`);
  }
  return pathspecs;
}

function splitGlobPatterns(patterns: string): string[] {
  const result: string[] = [];
  let current = "";
  let escaping = false;
  for (const character of patterns) {
    if (escaping) {
      current += character;
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === ",") {
      appendGlobPattern(result, current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaping) current += "\\";
  appendGlobPattern(result, current);
  return result;
}

function appendGlobPattern(patterns: string[], candidate: string): void {
  const pattern = candidate.trim();
  if (pattern) patterns.push(pattern);
}

function ingestRipgrepLine(
  line: string,
  cwd: string,
  accumulator: SearchAccumulator,
): "continue" | "stop" {
  if (!line) return "continue";
  const parsed = parseRipgrepLine(line);
  if (!isRipgrepMatch(parsed)) return "continue";

  const relativePath = normalizeResultPath(cwd, parsed.data.path.text);
  const lineContent = parsed.data.lines.text.replace(/\r?\n$/, "");
  for (const submatch of parsed.data.submatches) {
    const start = byteOffsetToStringOffset(lineContent, submatch.start);
    const end = byteOffsetToStringOffset(lineContent, submatch.end);
    const outcome = addMatch(
      accumulator,
      relativePath,
      lineContent,
      parsed.data.line_number,
      start,
      end,
    );
    if (outcome === "stop") return "stop";
  }
  return "continue";
}

function parseRipgrepLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function isRipgrepMatch(value: unknown): value is {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number; end: number }>;
  };
} {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== "match" || typeof message.data !== "object" || message.data === null) {
    return false;
  }
  const data = message.data as Record<string, unknown>;
  const pathValue = data.path as Record<string, unknown> | undefined;
  const lines = data.lines as Record<string, unknown> | undefined;
  return (
    typeof pathValue?.text === "string" &&
    typeof lines?.text === "string" &&
    typeof data.line_number === "number" &&
    Array.isArray(data.submatches) &&
    data.submatches.every(isRipgrepSubmatch)
  );
}

function isRipgrepSubmatch(value: unknown): value is { start: number; end: number } {
  if (typeof value !== "object" || value === null) return false;
  const match = value as Record<string, unknown>;
  return typeof match.start === "number" && typeof match.end === "number";
}

function byteOffsetToStringOffset(value: string, byteOffset: number): number {
  return Buffer.from(value).subarray(0, byteOffset).toString("utf8").length;
}

function ingestGitGrepLine(
  line: string,
  cwd: string,
  query: string,
  options: SearchOptions,
  accumulator: SearchAccumulator,
): "continue" | "stop" {
  const fields = line.split("\0");
  if (fields.length < 4) return "continue";
  const [reportedPath, lineText, columnText, ...contentParts] = fields;
  if (!reportedPath || !lineText || !columnText) return "continue";
  const lineNumber = Number(lineText);
  const reportedColumn = Number(columnText);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return "continue";
  const lineContent = contentParts.join("\0").replace(/\r$/, "");
  const relativePath = normalizeResultPath(cwd, reportedPath);
  const matcher = buildJavascriptMatcher(query, options);
  if (!matcher) {
    const start =
      Number.isSafeInteger(reportedColumn) && reportedColumn > 0 ? reportedColumn - 1 : 0;
    return addMatch(accumulator, relativePath, lineContent, lineNumber, start, start);
  }

  let match = matcher.exec(lineContent);
  while (match) {
    const outcome = addMatch(
      accumulator,
      relativePath,
      lineContent,
      lineNumber,
      match.index,
      match.index + match[0].length,
    );
    if (outcome === "stop") return "stop";
    if (match[0].length === 0) matcher.lastIndex += 1;
    match = matcher.exec(lineContent);
  }
  return "continue";
}

function buildJavascriptMatcher(query: string, options: SearchOptions): RegExp | null {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = options.useRegex ? query : escaped;
  const pattern = options.wholeWord ? `\\b${source}\\b` : source;
  try {
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function addMatch(
  accumulator: SearchAccumulator,
  relativePath: string,
  fullLineContent: string,
  line: number,
  start: number,
  end: number,
): "continue" | "stop" {
  if (accumulator.totalMatches >= accumulator.maxResults) {
    accumulator.truncated = true;
    return "stop";
  }
  const existingMatches = accumulator.files.get(relativePath) ?? [];
  if (existingMatches.length >= MAX_MATCHES_PER_FILE) {
    accumulator.truncated = true;
    return "continue";
  }

  const bounded = boundLineContent(fullLineContent, start, end);
  const match: FileSearchMatch = {
    line,
    column: start + 1,
    matchLength: Math.max(0, end - start),
    lineContent: bounded.content,
    ...(bounded.start > 0 ? { lineContentStartColumn: bounded.start + 1 } : {}),
  };
  existingMatches.push(match);
  accumulator.files.set(relativePath, existingMatches);
  accumulator.totalMatches += 1;
  return "continue";
}

function boundLineContent(
  lineContent: string,
  matchStart: number,
  matchEnd: number,
): { content: string; start: number } {
  if (lineContent.length <= MAX_LINE_CONTENT_LENGTH) return { content: lineContent, start: 0 };
  const matchLength = Math.min(Math.max(0, matchEnd - matchStart), MAX_LINE_CONTENT_LENGTH);
  const leftBudget = Math.floor((MAX_LINE_CONTENT_LENGTH - matchLength) / 2);
  let start = Math.max(0, matchStart - leftBudget);
  const end = Math.min(lineContent.length, start + MAX_LINE_CONTENT_LENGTH);
  start = Math.max(0, end - MAX_LINE_CONTENT_LENGTH);
  return { content: lineContent.slice(start, end), start };
}

function normalizeResultPath(cwd: string, reportedPath: string): string {
  const absolutePath = path.resolve(cwd, reportedPath);
  const relativePath = path.relative(cwd, absolutePath);
  const isOutside =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (isOutside) {
    throw new WorkspaceFileSearchError(
      "command_failed",
      "Search returned a path outside workspace",
    );
  }
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function isCommandMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function runSearchCommand(command: SearchCommand): Promise<SearchCommandResult> {
  if (command.signal.aborted) return { exitCode: null, stderr: "" };
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, command.args, {
      cwd: command.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let lineError: Error | null = null;
    let settled = false;

    function abort(): void {
      child.kill();
    }

    command.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (lineError) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STDOUT_LINE_LENGTH && !stdoutBuffer.includes("\n")) {
        lineError = new WorkspaceFileSearchError(
          "command_failed",
          "Search output line is too large",
        );
        child.kill();
        return;
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      try {
        for (const line of lines) command.onStdoutLine(line);
      } catch (error) {
        lineError = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_LENGTH)
        stderr += chunk.slice(0, MAX_STDERR_LENGTH - stderr.length);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      command.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      command.signal.removeEventListener("abort", abort);
      if (!lineError && stdoutBuffer && !command.signal.aborted) {
        try {
          command.onStdoutLine(stdoutBuffer);
        } catch (error) {
          lineError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (lineError) {
        reject(lineError);
        return;
      }
      resolve({ exitCode, stderr });
    });
  });
}
