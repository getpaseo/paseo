import { z } from "zod";

export type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
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

function buildLineDiff(originalText: string, updatedText: string): DiffLine[] {
  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) {
    return [];
  }

  const m = originalLines.length;
  const n = updatedLines.length;
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

  return diff;
}

function parseUnifiedDiff(diffText?: string): DiffLine[] {
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
