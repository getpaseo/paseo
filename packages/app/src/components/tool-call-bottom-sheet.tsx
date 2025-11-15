import React, { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import type { SelectedToolCall } from "@/types/shared";
import { z } from "zod";

type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
};

type EditEntry = {
  filePath?: string;
  diffLines: DiffLine[];
};

type ReadEntry = {
  filePath?: string;
  content: string;
};

type CommandDetails = {
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
    return mergeEditEntries(
      value.flatMap((entry) => parseEditArguments(entry, depth + 1))
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const entries: EditEntry[] = [];
  const filePathHint = getFilePathFromRecord(value);

  const changesParse = z.record(z.unknown()).safeParse(value["changes"]);
  if (changesParse.success) {
    for (const [filePath, changeValue] of Object.entries(changesParse.data)) {
      const nested = parseEditArguments(changeValue, depth + 1);
      entries.push(
        ...nested.map((entry) => ({
          ...entry,
          filePath: entry.filePath ?? filePath ?? filePathHint,
        }))
      );
    }
  }

  if (Array.isArray(value["files"])) {
    for (const fileEntry of value["files"] as unknown[]) {
      const nested = parseEditArguments(fileEntry, depth + 1);
      const derivedFilePath = isRecord(fileEntry)
        ? getFilePathFromRecord(fileEntry)
        : undefined;
      const resolvedFilePath = derivedFilePath ?? filePathHint;
      entries.push(
        ...nested.map((entry) => ({
          ...entry,
          filePath: entry.filePath ?? resolvedFilePath,
        }))
      );
    }
  }

  const direct = buildEditEntryFromBlock(filePathHint, value);
  if (direct) {
    entries.push(direct);
  } else {
    const patchCandidates = [
      getString(value["patch"]),
      getString(value["diff"]),
      getString(value["unified_diff"]),
      getString(value["unifiedDiff"]),
    ].filter(Boolean) as string[];
    for (const patch of patchCandidates) {
      if (patch && looksLikePatch(patch)) {
        const diffLines = parsePatchText(patch);
        if (diffLines.length) {
          entries.push({ filePath: filePathHint, diffLines });
          break;
        }
      }
    }
  }

  const nestedKeys = [
    "input",
    "update",
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

  return mergeEditEntries(entries);
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

function parseReadEntries(value: unknown, depth = 0): ReadEntry[] {
  if (!value || depth > 4) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? [{ content: value }] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseReadEntries(entry, depth + 1));
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
      entries.push(...parseReadEntries(value[key], depth + 1));
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
    if ((typeof exitCandidate === "number" || exitCandidate === null) && target.exitCode === undefined) {
      target.exitCode = exitCandidate ?? null;
    }
  }

  const resultParsed = CommandResultSchema.safeParse(value);
  if (resultParsed.success) {
    const data = resultParsed.data;
    const outputCandidate =
      getString(data.output) ??
      getString(data.structuredContent?.output) ??
      getString(data.structuredContent?.text) ??
      getString(data.structured_content?.output) ??
      getString(data.structured_content?.text) ??
      undefined;
    if (!target.output && outputCandidate) {
      target.output = outputCandidate;
    }
    const exitCandidate = data.exitCode ?? data.metadata?.exit_code;
    if ((typeof exitCandidate === "number" || exitCandidate === null) && target.exitCode === undefined) {
      target.exitCode = exitCandidate ?? null;
    }
    if (data.result !== undefined) {
      collectCommandDetails(target, data.result, depth + 1);
    }
  }

  const nestedKeys = [
    "input",
    "output",
    "result",
    "raw",
    "data",
    "payload",
    "structuredContent",
    "structured_content",
  ] as const;
  for (const key of nestedKeys) {
    if (value[key] !== undefined) {
      collectCommandDetails(target, value[key], depth + 1);
    }
  }
}

function parseCommandDetails(args: unknown, result: unknown): CommandDetails | null {
  const details: CommandDetails = {};
  collectCommandDetails(details, args);
  collectCommandDetails(details, result);
  if (details.command || details.output) {
    return details;
  }
  return null;
}

interface ToolCallBottomSheetProps {
  bottomSheetRef: React.RefObject<BottomSheetModal | null>;
  selectedToolCall: SelectedToolCall | null;
  onDismiss: () => void;
}

export function ToolCallBottomSheet({
  bottomSheetRef,
  selectedToolCall,
  onDismiss,
}: ToolCallBottomSheetProps) {
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ["80%"], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  // Extract data based on source
  const { toolName, args, result, error } = useMemo(() => {
    if (!selectedToolCall) {
      return {
        toolName: "Tool Call",
        args: undefined,
        result: undefined,
        error: undefined,
      };
    }

    const { payload } = selectedToolCall;

    if (payload.source === "agent") {
      const data = payload.data;
      return {
        toolName: data.displayName ?? `${data.server}/${data.tool}`,
        args: data.raw,
        result: data.result,
        error: data.error,
      };
    }

    const data = payload.data;
    return {
      toolName: data.toolName,
      args: data.arguments,
      result: data.result,
      error: data.error,
    };
  }, [selectedToolCall]);

  const editEntries = useMemo(() => {
    const entries = [
      ...parseEditArguments(args),
      ...parseEditArguments(result),
    ];
    return mergeEditEntries(entries);
  }, [args, result]);

  const readEntries = useMemo(() => {
    const entries = [
      ...parseReadEntries(result),
      ...parseReadEntries(args),
    ];
    return mergeReadEntries(entries);
  }, [args, result]);

  const commandDetails = useMemo(() => parseCommandDetails(args, result), [
    args,
    result,
  ]);

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      backdropComponent={renderBackdrop}
      enablePanDownToClose={true}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.background}
      topInset={insets.top}
      onDismiss={onDismiss}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.toolName}>{toolName || "Tool Call"}</Text>
      </View>

      {/* Scrollable content */}
      <BottomSheetScrollView
        contentContainerStyle={styles.sheetContent}
        showsVerticalScrollIndicator={true}
      >
        {editEntries.length > 0 &&
          editEntries.map((entry, index) => (
            <View key={`${entry.filePath ?? "file"}-${index}`} style={styles.section}>
              <Text style={styles.sectionTitle}>File</Text>
              <View style={styles.fileInfoContainer}>
                <Text style={styles.fileInfoText}>
                  {entry.filePath ?? "Unknown file"}
                </Text>
              </View>

              <Text style={styles.sectionTitle}>Diff</Text>
              <View style={styles.diffContainer}>
                {entry.diffLines.length === 0 ? (
                  <View style={styles.diffEmptyState}>
                    <Text style={styles.diffEmptyText}>No changes to display</Text>
                  </View>
                ) : (
                  <ScrollView
                    style={styles.diffScrollVertical}
                    contentContainerStyle={styles.diffVerticalContent}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                  >
                    <ScrollView
                      horizontal
                      nestedScrollEnabled
                      showsHorizontalScrollIndicator
                      contentContainerStyle={styles.diffScrollContent}
                    >
                      <View style={styles.diffLinesContainer}>
                        {entry.diffLines.map((line, lineIndex) => (
                          <View
                            key={`${line.type}-${lineIndex}`}
                            style={[
                              styles.diffLine,
                              line.type === "header" && styles.diffHeaderLine,
                              line.type === "add" && styles.diffAddLine,
                              line.type === "remove" && styles.diffRemoveLine,
                              line.type === "context" && styles.diffContextLine,
                            ]}
                          >
                            <Text
                              style={[
                                styles.diffLineText,
                                line.type === "header" && styles.diffHeaderText,
                                line.type === "add" && styles.diffAddText,
                                line.type === "remove" && styles.diffRemoveText,
                                line.type === "context" && styles.diffContextText,
                              ]}
                            >
                              {line.content}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  </ScrollView>
                )}
              </View>
            </View>
          ))}

        {readEntries.length > 0 &&
          readEntries.map((entry, index) => (
            <View key={`${entry.filePath ?? "read"}-${index}`} style={styles.section}>
              <Text style={styles.sectionTitle}>Read Result</Text>
              {entry.filePath && (
                <View style={styles.fileInfoContainer}>
                  <Text style={styles.fileInfoText}>{entry.filePath}</Text>
                </View>
              )}
              <ScrollView
                style={styles.contentScroll}
                contentContainerStyle={styles.contentContainer}
                nestedScrollEnabled={true}
                showsVerticalScrollIndicator={true}
              >
                <Text style={styles.contentText}>{entry.content}</Text>
              </ScrollView>
            </View>
          ))}

        {commandDetails && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Command Output</Text>
            {commandDetails.command && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Command</Text>
                <ScrollView horizontal nestedScrollEnabled={true} showsHorizontalScrollIndicator={true}>
                  <Text style={styles.commandMetaValue}>{commandDetails.command}</Text>
                </ScrollView>
              </View>
            )}
            {commandDetails.cwd && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Directory</Text>
                <ScrollView horizontal nestedScrollEnabled={true} showsHorizontalScrollIndicator={true}>
                  <Text style={styles.commandMetaValue}>{commandDetails.cwd}</Text>
                </ScrollView>
              </View>
            )}
            {commandDetails.exitCode !== undefined && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Exit Code</Text>
                <Text style={styles.commandMetaValue}>
                  {commandDetails.exitCode === null ? "Unknown" : commandDetails.exitCode}
                </Text>
              </View>
            )}
            {commandDetails.output && (
              <View style={styles.commandOutputContainer}>
                <Text style={styles.commandOutputLabel}>Output</Text>
                <ScrollView
                  style={styles.contentScroll}
                  contentContainerStyle={styles.contentContainer}
                  nestedScrollEnabled={true}
                  showsVerticalScrollIndicator={true}
                >
                  <Text style={styles.contentText}>{commandDetails.output}</Text>
                </ScrollView>
              </View>
            )}
          </View>
        )}

        {/* Content sections */}
        {args !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Arguments</Text>
            <ScrollView
              horizontal
              style={styles.jsonContainer}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={styles.jsonText}>
                {JSON.stringify(args, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}

        {result !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Result</Text>
            <ScrollView
              horizontal
              style={styles.jsonContainer}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={styles.jsonText}>
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}

        {error !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Error</Text>
            <ScrollView
              horizontal
              style={[styles.jsonContainer, styles.errorContainer]}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={[styles.jsonText, styles.errorText]}>
                {JSON.stringify(error, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  handleIndicator: {
    backgroundColor: theme.colors.border,
  },
  background: {
    backgroundColor: theme.colors.popover,
  },
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.popover,
  },
  toolName: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.popoverForeground,
  },
  sheetContent: {
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
  section: {
    marginBottom: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[2],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  fileInfoContainer: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  fileInfoText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  diffContainer: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  diffScrollVertical: {
    maxHeight: 280,
  },
  diffVerticalContent: {
    flexGrow: 1,
  },
  diffScrollContent: {
    flexDirection: "column" as const,
  },
  diffLinesContainer: {
    alignSelf: "flex-start",
  },
  diffLine: {
    minWidth: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  diffLineText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  diffHeaderLine: {
    backgroundColor: theme.colors.muted,
  },
  diffHeaderText: {
    color: theme.colors.mutedForeground,
  },
  diffAddLine: {
    backgroundColor: theme.colors.palette.green[900],
  },
  diffAddText: {
    color: theme.colors.palette.green[200],
  },
  diffRemoveLine: {
    backgroundColor: theme.colors.palette.red[900],
  },
  diffRemoveText: {
    color: theme.colors.palette.red[200],
  },
  diffContextLine: {
    backgroundColor: theme.colors.card,
  },
  diffContextText: {
    color: theme.colors.mutedForeground,
  },
  diffEmptyState: {
    padding: theme.spacing[4],
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  diffEmptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
  jsonContainer: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    // Natural height based on content
  },
  jsonContent: {
    padding: theme.spacing[3],
  },
  jsonText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
    // Text maintains whitespace and formatting
  },
  contentScroll: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    maxHeight: 280,
  },
  contentContainer: {
    padding: theme.spacing[3],
  },
  contentText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  errorContainer: {
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.background,
  },
  errorText: {
    color: theme.colors.destructive,
  },
  commandMetaContainer: {
    marginBottom: theme.spacing[2],
  },
  commandMetaLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[1],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  commandMetaValue: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandOutputContainer: {
    marginTop: theme.spacing[3],
  },
  commandOutputLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[1],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
}));
