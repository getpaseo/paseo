import stripAnsi from "strip-ansi";
import { z } from "zod";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "./perf";

const TOOL_CALL_DIFF_LOG_TAG = "[ToolCallDiff]";
const LINE_DIFF_DURATION_THRESHOLD_MS = 16;
const WORD_DIFF_DURATION_THRESHOLD_MS = 8;
const LINE_DIFF_MATRIX_THRESHOLD = 200000;
const WORD_DIFF_MATRIX_THRESHOLD = 50000;

export type DiffSegment = {
  text: string;
  changed: boolean;
};

export type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
  segments?: DiffSegment[];
};

export type EditEntry = {
  filePath?: string;
  diffLines: DiffLine[];
};

export type ReadEntry = {
  filePath?: string;
  content: string;
};

export type CommandDetails = {
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function splitIntoLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function splitIntoWords(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let inWord = false;

  for (const char of text) {
    const isWordChar = /\w/.test(char);
    if (isWordChar) {
      if (!inWord && current) {
        result.push(current);
        current = "";
      }
      inWord = true;
      current += char;
    } else {
      if (inWord && current) {
        result.push(current);
        current = "";
      }
      inWord = false;
      current += char;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function computeWordLevelDiff(oldLine: string, newLine: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const shouldLog = isPerfLoggingEnabled();
  const startMs = shouldLog ? getNowMs() : 0;
  const oldWords = splitIntoWords(oldLine);
  const newWords = splitIntoWords(newLine);

  const m = oldWords.length;
  const n = newWords.length;
  const matrixSize = m * n;

  // LCS to find common words
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldWords[i] === newWords[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Mark which words are in LCS (unchanged)
  const oldInLCS = new Set<number>();
  const newInLCS = new Set<number>();

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldWords[i] === newWords[j]) {
      oldInLCS.add(i);
      newInLCS.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // Build segments: consecutive unchanged or changed words merged
  const buildSegments = (words: string[], inLCS: Set<number>): DiffSegment[] => {
    if (words.length === 0) return [];

    const segments: DiffSegment[] = [];
    let currentText = "";
    let currentChanged: boolean | null = null;

    for (let idx = 0; idx < words.length; idx++) {
      const word = words[idx];
      const changed = !inLCS.has(idx);

      if (currentChanged === null) {
        currentText = word;
        currentChanged = changed;
      } else if (changed === currentChanged) {
        currentText += word;
      } else {
        segments.push({ text: currentText, changed: currentChanged });
        currentText = word;
        currentChanged = changed;
      }
    }

    if (currentText) {
      segments.push({ text: currentText, changed: currentChanged ?? false });
    }

    return segments;
  };

  const oldSegments = buildSegments(oldWords, oldInLCS);
  const newSegments = buildSegments(newWords, newInLCS);

  if (shouldLog) {
    const durationMs = getNowMs() - startMs;
    if (
      durationMs >= WORD_DIFF_DURATION_THRESHOLD_MS ||
      matrixSize >= WORD_DIFF_MATRIX_THRESHOLD
    ) {
      perfLog(TOOL_CALL_DIFF_LOG_TAG, {
        event: "word_diff",
        durationMs: Math.round(durationMs),
        oldWordCount: m,
        newWordCount: n,
        matrixSize,
      });
    }
  }

  return {
    oldSegments,
    newSegments,
  };
}

export function buildLineDiff(originalText: string, updatedText: string): DiffLine[] {
  const shouldLog = isPerfLoggingEnabled();
  const startMs = shouldLog ? getNowMs() : 0;
  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) {
    return [];
  }

  const m = originalLines.length;
  const n = updatedLines.length;
  const matrixSize = m * n;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (originalLines[i] === updatedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (originalLines[i] === updatedLines[j]) {
      diff.push({ type: "context", content: ` ${originalLines[i]}` });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: "remove", content: `-${originalLines[i]}` });
      i += 1;
    } else {
      diff.push({ type: "add", content: `+${updatedLines[j]}` });
      j += 1;
    }
  }

  while (i < m) {
    diff.push({ type: "remove", content: `-${originalLines[i]}` });
    i += 1;
  }

  while (j < n) {
    diff.push({ type: "add", content: `+${updatedLines[j]}` });
    j += 1;
  }

  // Post-process to add word-level segments for adjacent remove/add pairs
  for (let idx = 0; idx < diff.length - 1; idx++) {
    const curr = diff[idx];
    const next = diff[idx + 1];

    if (curr.type === "remove" && next.type === "add") {
      // Strip the leading -/+ from content for comparison
      const oldLineText = curr.content.slice(1);
      const newLineText = next.content.slice(1);

      const { oldSegments, newSegments } = computeWordLevelDiff(oldLineText, newLineText);
      curr.segments = oldSegments;
      next.segments = newSegments;
    }
  }

  if (shouldLog) {
    const durationMs = getNowMs() - startMs;
    if (
      durationMs >= LINE_DIFF_DURATION_THRESHOLD_MS ||
      matrixSize >= LINE_DIFF_MATRIX_THRESHOLD
    ) {
      perfLog(TOOL_CALL_DIFF_LOG_TAG, {
        event: "line_diff",
        durationMs: Math.round(durationMs),
        originalLineCount: m,
        updatedLineCount: n,
        diffLineCount: diff.length,
        matrixSize,
      });
    }
  }

  return diff;
}

export function parseUnifiedDiff(diffText?: string): DiffLine[] {
  if (!diffText) {
    return [];
  }

  const lines = splitIntoLines(diffText);
  const diff: DiffLine[] = [];

  for (const line of lines) {
    if (!line.length) {
      diff.push({ type: "context", content: line });
      continue;
    }

    if (line.startsWith("@@")) {
      diff.push({ type: "header", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) {
        diff.push({ type: "add", content: line });
      }
      continue;
    }

    if (line.startsWith("-")) {
      if (!line.startsWith("---")) {
        diff.push({ type: "remove", content: line });
      }
      continue;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      diff.push({ type: "header", content: line });
      continue;
    }

    diff.push({ type: "context", content: line });
  }

  return diff;
}

function deriveDiffLines({
  unifiedDiff,
  original,
  updated,
}: {
  unifiedDiff?: string;
  original?: string;
  updated?: string;
}): DiffLine[] {
  if (unifiedDiff) {
    const parsed = parseUnifiedDiff(unifiedDiff);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (original !== undefined || updated !== undefined) {
    return buildLineDiff(original ?? "", updated ?? "");
  }

  return [];
}

function looksLikePatch(text: string): boolean {
  if (!text) {
    return false;
  }
  return /(\*\*\* Begin Patch|@@|diff --git|\+\+\+|--- )/.test(text);
}

function parsePatchText(text: string): DiffLine[] {
  if (!text) {
    return [];
  }
  return parseUnifiedDiff(text);
}

function getFilePathFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    getString(record["file_path"]) ??
    getString(record["filePath"]) ??
    getString(record["path"]) ??
    getString(record["target_path"]) ??
    getString(record["targetPath"]) ??
    undefined
  );
}

const ChangeBlockSchema = z
  .object({
    unified_diff: z.string().optional(),
    unifiedDiff: z.string().optional(),
    diff: z.string().optional(),
    patch: z.string().optional(),
    old_content: z.string().optional(),
    oldContent: z.string().optional(),
    previous_content: z.string().optional(),
    previousContent: z.string().optional(),
    base_content: z.string().optional(),
    baseContent: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    new_content: z.string().optional(),
    newContent: z.string().optional(),
    replace_with: z.string().optional(),
    replaceWith: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

function buildEditEntryFromBlock(
  filePath: string | undefined,
  blockValue: Record<string, unknown>
): EditEntry | null {
  const parsed = ChangeBlockSchema.safeParse(blockValue);
  if (!parsed.success) {
    return null;
  }

  const data = parsed.data;
  const diffLines = deriveDiffLines({
    unifiedDiff:
      getString(
        data.unified_diff ??
          data.unifiedDiff ??
          data.patch ??
          data.diff
      ) ?? undefined,
    original:
      getString(
        data.old_string ??
          data.old_content ??
          data.oldContent ??
          data.previous_content ??
          data.previousContent ??
          data.base_content ??
          data.baseContent
      ) ?? undefined,
    updated:
      getString(
        data.new_string ??
          data.new_content ??
          data.newContent ??
          data.replace_with ??
          data.replaceWith ??
          data.content
      ) ?? undefined,
  });

  if (diffLines.length > 0) {
    return {
      filePath: filePath ?? getFilePathFromRecord(blockValue),
      diffLines,
    };
  }

  const patchCandidate =
    getString(data.unified_diff ?? data.unifiedDiff ?? data.patch ?? data.diff) ??
    undefined;
  if (patchCandidate && looksLikePatch(patchCandidate)) {
    const parsedLines = parsePatchText(patchCandidate);
    if (parsedLines.length > 0) {
      return {
        filePath: filePath ?? getFilePathFromRecord(blockValue),
        diffLines: parsedLines,
      };
    }
  }

  return null;
}

function mergeEditEntries(entries: EditEntry[]): EditEntry[] {
  if (entries.length === 0) {
    return [];
  }
  const seen = new Map<string, EditEntry>();
  entries.forEach((entry) => {
    if (!entry.diffLines.length) {
      return;
    }
    const hash = `${entry.filePath ?? "unknown"}::${entry.diffLines
      .map((line) => `${line.type}:${line.content}`)
      .join("|")}`;
    if (!seen.has(hash)) {
      seen.set(hash, entry);
    }
  });
  return Array.from(seen.values());
}

function parseEditArguments(value: unknown, depth = 0): EditEntry[] {
  if (!value || depth > 5) {
    return [];
  }

  if (typeof value === "string") {
    if (looksLikePatch(value)) {
      const diffLines = parsePatchText(value);
      return diffLines.length ? [{ diffLines }] : [];
    }
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseEditArguments(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const filePathHint = getFilePathFromRecord(value) ?? getString(value["name"]);

  if (value["patch"] || value["diff"] || value["unified_diff"] || value["unifiedDiff"]) {
    const entry = buildEditEntryFromBlock(filePathHint, value);
    return entry ? [entry] : [];
  }

  const entries: EditEntry[] = [];
  const changeKeys = [
    "changes",
    "files",
    "fileChanges",
    "file_changes",
    "edits",
    "diffs",
    "patches",
    "fileDiffs",
    "file_diffs",
  ] as const;

  for (const key of changeKeys) {
    const block = value[key];
    if (!block) {
      continue;
    }
    if (Array.isArray(block)) {
      for (const item of block) {
        if (isRecord(item)) {
          const entry = buildEditEntryFromBlock(filePathHint, item);
          if (entry) {
            entries.push(entry);
          }
        }
      }
      continue;
    }
    if (isRecord(block)) {
      if (block["patch"] || block["diff"]) {
        const entry = buildEditEntryFromBlock(filePathHint, block);
        if (entry) {
          entries.push(entry);
        }
        continue;
      }
      for (const [path, nested] of Object.entries(block)) {
        if (isRecord(nested)) {
          const entry = buildEditEntryFromBlock(path, nested);
          if (entry) {
            entries.push(entry);
          }
        } else if (typeof nested === "string" && looksLikePatch(nested)) {
          const diffLines = parsePatchText(nested);
          if (diffLines.length) {
            entries.push({ filePath: path, diffLines });
          }
        }
      }
    }
  }

  const changeEntry = buildEditEntryFromBlock(filePathHint, value);
  if (changeEntry) {
    entries.push(changeEntry);
  }

  const nestedKeys = [
    "create",
    "delete",
    "raw",
    "data",
    "payload",
    "arguments",
    "result",
  ] as const;
  for (const key of nestedKeys) {
    if (value[key] !== undefined) {
      const nestedEntries = parseEditArguments(value[key], depth + 1);
      entries.push(
        ...nestedEntries.map((entry) => ({
          ...entry,
          filePath: entry.filePath ?? filePathHint,
        }))
      );
    }
  }

  return entries;
}

const ReadContainerSchema = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    data: z
      .object({
        content: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    structuredContent: z
      .object({
        content: z.string().optional(),
        text: z.string().optional(),
        data: z
          .object({
            content: z.string().optional(),
            text: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    structured_content: z
      .object({
        content: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    output: z
      .object({
        content: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function parseReadEntriesInternal(value: unknown, depth = 0): ReadEntry[] {
  if (!value || depth > 4) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? [{ content: value }] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseReadEntriesInternal(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const parsed = ReadContainerSchema.safeParse(value);
  if (parsed.success) {
    const data = parsed.data;
    const content =
      getString(data.content) ??
      getString(data.text) ??
      getString(data.blob) ??
      getString(data.data?.content) ??
      getString(data.data?.text) ??
      getString(data.structuredContent?.content) ??
      getString(data.structuredContent?.text) ??
      getString(data.structuredContent?.data?.content) ??
      getString(data.structuredContent?.data?.text) ??
      getString(data.structured_content?.content) ??
      getString(data.structured_content?.text) ??
      getString(data.output?.content) ??
      getString(data.output?.text);
    if (content) {
      return [
        {
          filePath: data.filePath ?? data.file_path ?? data.path,
          content,
        },
      ];
    }
  }

  const nestedKeys = [
    "output",
    "result",
    "structuredContent",
    "structured_content",
    "data",
    "raw",
    "value",
    "content",
  ] as const;
  const entries: ReadEntry[] = [];
  for (const key of nestedKeys) {
    if (value[key] !== undefined) {
      entries.push(...parseReadEntriesInternal(value[key], depth + 1));
    }
  }
  return entries;
}

function mergeReadEntries(entries: ReadEntry[]): ReadEntry[] {
  if (!entries.length) {
    return [];
  }
  const seen = new Map<string, ReadEntry>();
  entries.forEach((entry) => {
    const hash = `${entry.filePath ?? "content"}::${entry.content}`;
    if (!seen.has(hash)) {
      seen.set(hash, entry);
    }
  });
  return Array.from(seen.values());
}

const CommandRawSchema = z
  .object({
    type: z.string().optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
    aggregated_output: z.string().optional(),
    exit_code: z.number().optional(),
    cwd: z.string().optional(),
    directory: z.string().optional(),
    metadata: z
      .object({
        exit_code: z.number().optional(),
      })
      .optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

const CommandResultSchema = z
  .object({
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    structuredContent: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
    structured_content: z
      .object({
        output: z.string().optional(),
        text: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
    metadata: z
      .object({
        exit_code: z.number().optional(),
      })
      .optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

function coerceCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    const tokens = value.filter((entry): entry is string => typeof entry === "string");
    if (tokens.length) {
      return tokens.join(" ");
    }
  }
  return undefined;
}

function collectCommandDetails(
  target: CommandDetails,
  value: unknown,
  depth = 0
): void {
  if (!value || depth > 4) {
    return;
  }

  if (typeof value === "string") {
    if (!target.output) {
      target.output = value;
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const rawParsed = CommandRawSchema.safeParse(value);
  if (rawParsed.success) {
    const data = rawParsed.data;
    const commandCandidate =
      coerceCommandValue(data.command) ??
      (isRecord(data.input) ? coerceCommandValue(data.input["command"]) : undefined);
    if (!target.command && commandCandidate) {
      target.command = commandCandidate;
    }
    const cwdCandidate =
      getString(data.cwd ?? data.directory) ??
      (isRecord(data.input)
        ? getString(data.input["cwd"] ?? data.input["directory"])
        : undefined);
    if (!target.cwd && cwdCandidate) {
      target.cwd = cwdCandidate;
    }
    const aggregatedOutput =
      getString(data.aggregated_output) ??
      (isRecord(data.output)
        ? getString(
            (data.output as Record<string, unknown>)["aggregated_output"] ??
              (data.output as Record<string, unknown>)["output"] ??
              (data.output as Record<string, unknown>)["text"]
          )
        : undefined);
    if (!target.output && aggregatedOutput) {
      target.output = aggregatedOutput;
    }
    const exitCandidate =
      data.exit_code ??
      (data.metadata ? data.metadata.exit_code : undefined) ??
      (isRecord(data.output)
        ? ((data.output as Record<string, unknown>)["exit_code"] as number | undefined) ??
          ((data.output as Record<string, unknown>)["exitCode"] as number | undefined)
        : undefined);
    if (target.exitCode === undefined && exitCandidate !== undefined) {
      target.exitCode = exitCandidate;
    }
  }

  const resultParsed = CommandResultSchema.safeParse(value);
  if (resultParsed.success) {
    const data = resultParsed.data;
    if (!target.output) {
      target.output =
        getString(data.output) ??
        getString(data.structuredContent?.output) ??
        getString(data.structuredContent?.text) ??
        getString(data.structured_content?.output) ??
        getString(data.structured_content?.text) ??
        (typeof data.result === "string" ? data.result : undefined);
    }
    if (target.exitCode === undefined) {
      target.exitCode = data.exitCode ?? data.metadata?.exit_code;
    }
    if (!target.command && isRecord(data.result)) {
      const nestedCommand =
        coerceCommandValue(data.result["command"]) ??
        coerceCommandValue((data.result as Record<string, unknown>)["args"]);
      if (nestedCommand) {
        target.command = nestedCommand;
      }
    }
  }

  const nestedKeys = [
    "input",
    "output",
    "result",
    "response",
    "data",
    "raw",
    "payload",
  ] as const;
  for (const key of nestedKeys) {
    if (value[key] !== undefined) {
      collectCommandDetails(target, value[key], depth + 1);
    }
  }
}

export function extractEditEntries(...sources: unknown[]): EditEntry[] {
  const entries = sources.flatMap((value) => parseEditArguments(value));
  return mergeEditEntries(entries);
}

export function extractReadEntries(...sources: unknown[]): ReadEntry[] {
  return mergeReadEntries(sources.flatMap((value) => parseReadEntriesInternal(value)));
}

export function extractCommandDetails(...sources: unknown[]): CommandDetails | null {
  const details: CommandDetails = {};
  sources.forEach((value) => collectCommandDetails(details, value));
  if (details.command || details.output || details.cwd) {
    return details;
  }
  return null;
}

// ---- Key-Value Extraction for Generic Tool Results ----

export interface KeyValuePair {
  key: string;
  value: string;
}

const WrappedOutputSchema = z
  .object({ output: z.record(z.unknown()) })
  .transform((data) => data.output);

const DirectRecordSchema = z.record(z.unknown());

const ToolResultRecordSchema = z.union([WrappedOutputSchema, DirectRecordSchema]);

function stringifyValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractKeyValuePairs(result: unknown): KeyValuePair[] {
  const parsed = ToolResultRecordSchema.safeParse(result);
  if (!parsed.success) {
    return [];
  }

  const record = parsed.data;
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: stringifyValue(value),
  }));
}

// ---- Tool Call Display Discriminated Union ----

const KeyValuePairsSchema = z.record(z.unknown()).transform((data) =>
  Object.entries(data).map(([key, value]) => ({
    key,
    value: stringifyValue(value),
  }))
);

// Shell input: { command: "pwd", description?: "..." }
const ShellInputSchema = z.object({
  command: z.union([z.string(), z.array(z.string())]),
}).passthrough();

// Shell result (when completed): { type: "command", command: "pwd", output: "..." }
const ShellResultSchema = z.object({
  type: z.literal("command"),
  output: z.string(),
}).passthrough();

// Shell error result: { type: "tool_result", content: "Exit code 128\n...", is_error: true }
const ShellErrorResultSchema = z.object({
  type: z.literal("tool_result"),
  content: z.string(),
  is_error: z.literal(true),
}).passthrough();

// Shell tool call display schema
const ShellToolCallSchema = z
  .object({
    input: ShellInputSchema,
    result: z.unknown(),
  })
  .transform((data) => {
    const command = Array.isArray(data.input.command)
      ? data.input.command.join(" ")
      : data.input.command;

    // Try parsing as success result first
    const resultParsed = ShellResultSchema.safeParse(data.result);
    if (resultParsed.success) {
      return {
        type: "shell" as const,
        command,
        output: stripAnsi(resultParsed.data.output),
      };
    }

    // Try parsing as error result
    const errorParsed = ShellErrorResultSchema.safeParse(data.result);
    if (errorParsed.success) {
      return {
        type: "shell" as const,
        command,
        output: stripAnsi(errorParsed.data.content),
      };
    }

    return {
      type: "shell" as const,
      command,
      output: "",
    };
  });

// Edit input: { file_path: string, old_string: string, new_string: string }
// Also supports old_str/new_str variants
const EditInputSchema = z.union([
  z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
  }).passthrough(),
  z.object({
    file_path: z.string(),
    old_str: z.string(),
    new_str: z.string(),
  }).passthrough(),
]);

// Edit result: { type: "file_edit", filePath: string, oldContent?: string, newContent?: string }
const EditResultSchema = z.object({
  type: z.literal("file_edit"),
  filePath: z.string(),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
}).passthrough();

// Edit tool call display schema
const EditToolCallSchema = z
  .object({
    input: EditInputSchema,
    result: z.unknown(),
  })
  .transform((data): { type: "edit"; filePath: string; oldString: string; newString: string; unifiedDiff?: string } => {
    const filePath = data.input.file_path;
    const oldString = "old_string" in data.input
      ? (data.input as { old_string: string }).old_string
      : (data.input as { old_str: string }).old_str;
    const newString = "new_string" in data.input
      ? (data.input as { new_string: string }).new_string
      : (data.input as { new_str: string }).new_str;

    return {
      type: "edit",
      filePath,
      oldString,
      newString,
    };
  });

// Codex apply_patch input: { files: [{ path: string, kind: string }] }
const ApplyPatchInputSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    kind: z.string().optional(),
  })).min(1),
}).passthrough();

// Codex apply_patch result: { files: [{ path: string, patch: string, kind: string }], message: string, success: boolean }
const ApplyPatchResultSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    patch: z.string().optional(),
    kind: z.string().optional(),
  })).optional(),
  message: z.string().optional(),
  success: z.boolean().optional(),
}).passthrough();

// Apply patch tool call display schema - transforms to edit type with unified diff
const ApplyPatchToolCallSchema = z
  .object({
    input: ApplyPatchInputSchema,
    result: z.unknown(),
  })
  .transform((data): { type: "edit"; filePath: string; oldString: string; newString: string; unifiedDiff?: string } => {
    const firstFile = data.input.files[0];
    const filePath = firstFile.path;

    // Try to get the patch from the result
    const resultParsed = ApplyPatchResultSchema.safeParse(data.result);
    let unifiedDiff: string | undefined;
    if (resultParsed.success && resultParsed.data.files) {
      const resultFile = resultParsed.data.files.find(f => f.path === filePath) ?? resultParsed.data.files[0];
      unifiedDiff = resultFile?.patch;
    }

    return {
      type: "edit",
      filePath,
      oldString: "",
      newString: "",
      unifiedDiff,
    };
  });

// Read input: { file_path: string, offset?: number, limit?: number }
const ReadInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
}).passthrough();

// Read result: { type: "file_read", filePath: string, content: string }
const ReadResultSchema = z.object({
  type: z.literal("file_read"),
  filePath: z.string(),
  content: z.string(),
}).passthrough();

// Read tool call display schema (Claude)
const ReadToolCallSchema = z
  .object({
    input: ReadInputSchema,
    result: ReadResultSchema,
  })
  .transform((data): { type: "read"; filePath: string; content: string; offset?: number; limit?: number } => ({
    type: "read",
    filePath: data.input.file_path,
    content: data.result.content,
    offset: data.input.offset,
    limit: data.input.limit,
  }));

// Codex read_file input: { path: string }
const CodexReadInputSchema = z.object({
  path: z.string(),
}).passthrough();

// Codex read_file result: { type: "read_file", path: string, content: string }
const CodexReadResultSchema = z.object({
  type: z.literal("read_file"),
  path: z.string(),
  content: z.string(),
}).passthrough();

// Codex read_file tool call display schema
const CodexReadToolCallSchema = z
  .object({
    input: CodexReadInputSchema,
    result: CodexReadResultSchema,
  })
  .transform((data): { type: "read"; filePath: string; content: string; offset?: number; limit?: number } => ({
    type: "read",
    filePath: data.input.path,
    content: data.result.content,
  }));

// Generic tool call display schema (fallback)
const GenericToolCallSchema = z
  .object({
    input: z.unknown(),
    result: z.unknown(),
  })
  .transform((data) => {
    const inputPairs = KeyValuePairsSchema.safeParse(data.input);
    const resultPairs = KeyValuePairsSchema.safeParse(data.result);

    return {
      type: "generic" as const,
      input: inputPairs.success ? inputPairs.data : [],
      output: resultPairs.success ? resultPairs.data : [],
    };
  });

// Normalizes tool names for consistent display across agents
const TOOL_NAME_MAP: Record<string, string> = {
  shell: "Shell",
  Bash: "Shell",
  read_file: "Read",
  apply_patch: "Edit",
  paseo_worktree_setup: "Setup",
  thinking: "Thinking",
};

const ToolCallDisplaySchema = z
  .object({
    toolName: z.string(),
    input: z.unknown(),
    result: z.unknown(),
  })
  .transform((data) => {
    const normalizedToolName = TOOL_NAME_MAP[data.toolName] ?? data.toolName;

    // Handle thinking - input is the thinking text content
    if (data.toolName === "thinking") {
      const content = typeof data.input === "string" ? data.input : "";
      return {
        type: "thinking" as const,
        content,
        toolName: normalizedToolName,
      };
    }

    // Try each schema in order
    const shellParsed = ShellToolCallSchema.safeParse({ input: data.input, result: data.result });
    if (shellParsed.success) {
      return { ...shellParsed.data, toolName: normalizedToolName };
    }

    const editParsed = EditToolCallSchema.safeParse({ input: data.input, result: data.result });
    if (editParsed.success) {
      return { ...editParsed.data, toolName: normalizedToolName };
    }

    // Codex apply_patch - try before read since it also uses files array
    const applyPatchParsed = ApplyPatchToolCallSchema.safeParse({ input: data.input, result: data.result });
    if (applyPatchParsed.success) {
      return { ...applyPatchParsed.data, toolName: normalizedToolName };
    }

    const readParsed = ReadToolCallSchema.safeParse({ input: data.input, result: data.result });
    if (readParsed.success) {
      return { ...readParsed.data, toolName: normalizedToolName };
    }

    // Codex read_file
    const codexReadParsed = CodexReadToolCallSchema.safeParse({ input: data.input, result: data.result });
    if (codexReadParsed.success) {
      return { ...codexReadParsed.data, toolName: normalizedToolName };
    }

    // Fallback to generic
    const genericParsed = GenericToolCallSchema.parse({ input: data.input, result: data.result });
    return { ...genericParsed, toolName: normalizedToolName };
  });

export type ToolCallDisplay = z.infer<typeof ToolCallDisplaySchema>;

export function parseToolCallDisplay(toolName: string, input: unknown, result: unknown): ToolCallDisplay {
  return ToolCallDisplaySchema.parse({ toolName, input, result });
}

// ---- Task Extraction (cross-provider) ----

export type TaskStatus = "pending" | "in_progress" | "completed";

export type TaskEntry = {
  text: string;
  status: TaskStatus;
  completed: boolean;
};

const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const ClaudeTodoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: TaskStatusSchema,
      activeForm: z.string().optional(),
    })
  ),
});

const UpdatePlanSchema = z.object({
  plan: z.array(
    z.object({
      step: z.string(),
      status: TaskStatusSchema.catch("pending"),
    })
  ),
});

function normalizeToolName(toolName: string): string {
  return toolName.trim().replace(/[.\s-]+/g, "_").toLowerCase();
}

export function extractTaskEntriesFromToolCall(
  toolName: string,
  input: unknown
): TaskEntry[] | null {
  const normalized = normalizeToolName(toolName);

  // Claude's plan mode uses ExitPlanMode for the approval prompt; it is not a task list.
  if (normalized === "exitplanmode") {
    return null;
  }

  if (normalized === "todowrite" || normalized === "todo_write") {
    const parsed = ClaudeTodoWriteSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.todos.map((todo) => {
      const status = todo.status;
      const text = todo.activeForm?.trim() || todo.content.trim();
      return {
        text: text.length ? text : todo.content,
        status,
        completed: status === "completed",
      };
    });
  }

  if (normalized === "update_plan") {
    const parsed = UpdatePlanSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.plan
      .map((entry) => ({
        text: entry.step.trim(),
        status: entry.status,
        completed: entry.status === "completed",
      }))
      .filter((entry) => entry.text.length > 0);
  }

  return null;
}

// ---- Principal Parameter Extraction ----
// Re-export from server to avoid drift
export {
  extractPrincipalParam,
  stripCwdPrefix,
  extractTodos,
  type TodoItem,
} from "@paseo/server/utils/tool-call-parsers";
