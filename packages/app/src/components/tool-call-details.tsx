import React, { useEffect, useMemo, type ReactNode } from "react";
import {
  View,
  Text,
  ScrollView as RNScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { buildLineDiff, parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { hasMeaningfulToolCallDetail } from "@/utils/tool-call-detail-state";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { extensionFromPath, highlightToKeyedLines } from "@/utils/highlight-cache";
import { HighlightedLines } from "./highlighted-content";
import {
  HighlightedText,
  mapSourceOccurrenceToDisplayedOffset,
} from "@/timeline-search/highlighted-text";
import { useTimelineHighlightQuery } from "@/timeline-search/highlight";
import { useTimelineSearchOccurrenceAnchor } from "@/timeline-search/occurrence-anchor";
import { useTimelineSearchTarget } from "@/timeline-search/search-target";
import type { TimelineSearchField } from "@/timeline-search/timeline-search-model";
import { DiffViewer } from "./diff-viewer";
import { getCodeInsets } from "./code-insets";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  detail?: ToolCallDetail;
  timelineSearchItemId?: string;
  timelineSearchField?: TimelineSearchField;
  errorText?: string;
  maxHeight?: number;
  fillAvailableHeight?: boolean;
  showLoadingSkeleton?: boolean;
}

interface DetailStyles {
  sectionFillStyle: StyleProp<ViewStyle>;
  codeBlockFillStyle: StyleProp<ViewStyle>;
  codeVerticalScrollStyle: StyleProp<ViewStyle>;
  scrollAreaFillStyle: StyleProp<ViewStyle>;
  scrollAreaStyle: StyleProp<ViewStyle>;
  jsonScrollCombined: StyleProp<ViewStyle>;
  jsonScrollErrorCombined: StyleProp<ViewStyle>;
  fullBleedContainerStyle: StyleProp<ViewStyle>;
  loadingContainerStyle: StyleProp<ViewStyle>;
  resolvedMaxHeight: number | undefined;
  shouldFill: boolean;
  isFullBleed: boolean;
}

interface ToolDetailScrollHandle {
  scrollTo: (options: { x?: number; y?: number; animated?: boolean }) => void;
}

interface ActiveToolDetailField {
  field: TimelineSearchField;
  text: string;
  /** Canonical source when text is a display-only transformation of it. */
  sourceText?: string;
  /** The rendered line on which this field begins. */
  startLine?: number;
}

const TOOL_DETAIL_LINE_HEIGHT = 18;
const TOOL_DETAIL_REVEAL_CONTEXT_LINES = 4;

/**
 * The outer timeline can reveal a tool-call card, but a long tool output is
 * itself a capped ScrollView. Keep that inner viewport aligned to the selected
 * field before the shared occurrence anchor measures the exact text span.
 */
function useRevealActiveToolDetailLine({
  scrollRef,
  itemId,
  fields,
}: {
  scrollRef: React.RefObject<ToolDetailScrollHandle | null>;
  itemId?: string;
  fields: readonly ActiveToolDetailField[];
}) {
  const target = useTimelineSearchTarget();
  const query = useTimelineHighlightQuery();
  useEffect(() => {
    if (!itemId || target?.itemId !== itemId) {
      return;
    }
    const field = fields.find((candidate) => candidate.field === target.field);
    if (!field || target.fieldOffset < 0 || target.fieldOffset > field.text.length) {
      return;
    }
    const displayFieldOffset = field.sourceText
      ? mapSourceOccurrenceToDisplayedOffset({
          sourceText: field.sourceText,
          displayedText: field.text,
          query,
          sourceFieldOffset: target.fieldOffset,
        })
      : target.fieldOffset;
    if (displayFieldOffset === null) return;
    const line =
      (field.startLine ?? 0) + field.text.slice(0, displayFieldOffset).split("\n").length - 1;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(0, (line - TOOL_DETAIL_REVEAL_CONTEXT_LINES) * TOOL_DETAIL_LINE_HEIGHT),
        animated: false,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fields, itemId, query, scrollRef, target]);
}

function resolveIsFullBleed(detail: ToolCallDetail | undefined): boolean {
  return detail?.type === "edit" || detail?.type === "shell" || detail?.type === "write";
}

function resolveShouldFill(
  detail: ToolCallDetail | undefined,
  fillAvailableHeight: boolean,
): boolean {
  if (!fillAvailableHeight) return false;
  const t = detail?.type;
  return t === "shell" || t === "edit" || t === "write" || t === "read" || t === "sub_agent";
}

function useDetailStyles(
  detail: ToolCallDetail | undefined,
  resolvedMaxHeight: number | undefined,
  fillAvailableHeight: boolean,
): DetailStyles {
  const isFullBleed = resolveIsFullBleed(detail);
  const shouldFill = resolveShouldFill(detail, fillAvailableHeight);
  const codeBlockStyle = isFullBleed ? styles.fullBleedBlock : styles.diffContainer;

  const sectionFillStyle = useMemo(
    () => [styles.section, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const codeBlockFillStyle = useMemo(
    () => [codeBlockStyle, shouldFill && styles.fillHeight],
    [codeBlockStyle, shouldFill],
  );
  const codeVerticalScrollStyle = useMemo(
    () => [
      styles.codeVerticalScroll,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaFillStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
    ],
    [resolvedMaxHeight],
  );
  const jsonScrollCombined = styles.jsonScroll;
  const jsonScrollErrorCombined = [styles.jsonScroll, styles.jsonScrollError];
  const fullBleedContainerStyle = useMemo(
    () => [
      isFullBleed ? styles.fullBleedContainer : styles.paddedContainer,
      shouldFill && styles.fillHeight,
    ],
    [isFullBleed, shouldFill],
  );
  const loadingContainerStyle = useMemo(
    () => [styles.loadingContainer, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  return {
    sectionFillStyle,
    codeBlockFillStyle,
    codeVerticalScrollStyle,
    scrollAreaFillStyle,
    scrollAreaStyle,
    jsonScrollCombined,
    jsonScrollErrorCombined,
    fullBleedContainerStyle,
    loadingContainerStyle,
    resolvedMaxHeight,
    shouldFill,
    isFullBleed,
  };
}

function useDiffLines(detail: ToolCallDetail | undefined): DiffLine[] | undefined {
  return useMemo(() => {
    if (!detail || detail.type !== "edit") return undefined;
    const diffLines = detail.unifiedDiff
      ? parseUnifiedDiff(detail.unifiedDiff)
      : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
    return highlightDiffLines(diffLines, detail.filePath);
  }, [detail]);
}

interface ShellDetailProps {
  command: string;
  output: string | null | undefined;
  ds: DetailStyles;
  itemId?: string;
}

function ShellDetailSection({ command, output, ds, itemId }: ShellDetailProps) {
  // Only trailing whitespace is trimmed off `command` for display — that
  // can't shift any match's start offset, so it stays exactly the "toolInput"
  // field text `extractSearchSpans` extracted (see buildDetailInputParts's
  // "shell" case) and `fieldOffset` lines up.
  const normalizedCommand = command.replace(/\n+$/, "");
  // The output field is rendered RAW (no leading-newline trim) so its text
  // stays exactly the "toolOutput" span text (extractDetailOutput's "shell"
  // case returns `detail.output` untouched) — trimming here would shift
  // every match's offset left and break `fieldOffset` alignment.
  const outputText = output ?? "";
  const hasOutput = outputText.replace(/^\n+/, "").length > 0;
  const scrollRef = useRef<RNScrollView>(null);
  const fields = useMemo(
    () => [
      { field: "toolInput" as const, text: normalizedCommand },
      {
        field: "toolOutput" as const,
        text: outputText,
        startLine: normalizedCommand.split("\n").length + 1,
      },
    ],
    [normalizedCommand, outputText],
  );
  useRevealActiveToolDetailLine({
    scrollRef,
    itemId,
    fields,
  });
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          ref={scrollRef}
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                <Text style={styles.shellPrompt}>$ </Text>
                <HighlightedText text={normalizedCommand} itemId={itemId} field="toolInput" />
                {hasOutput
                  ? [
                      "\n\n",
                      <HighlightedText
                        key="output"
                        text={outputText}
                        itemId={itemId}
                        field="toolOutput"
                      />,
                    ]
                  : ""}
              </Text>
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

interface WorktreeSetupDetailProps {
  log: string;
  branchName: string;
  worktreePath: string;
  ds: DetailStyles;
  itemId?: string;
}

function WorktreeSetupDetailSection({
  log,
  branchName,
  worktreePath,
  ds,
  itemId,
}: WorktreeSetupDetailProps) {
  const hasLog = log.replace(/^\n+/, "").length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                {hasLog ? (
                  // Rendered RAW (no leading-newline trim) to match
                  // extractDetailOutput's "worktree_setup" case (`detail.log`
                  // untouched), so fieldOffset stays aligned.
                  <HighlightedText text={log} itemId={itemId} field="toolOutput" />
                ) : (
                  `Preparing worktree ${branchName} at ${worktreePath}`
                )}
              </Text>
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function resolveSubAgentFallbackHeader(
  subAgentType: string | null | undefined,
  description: string | null | undefined,
  fallbackText: string,
): string {
  if (subAgentType && description) {
    return `${subAgentType}: ${description}`;
  }
  return subAgentType ?? description ?? fallbackText;
}

interface SubAgentDetailProps {
  log: string;
  childSessionId: string | null | undefined;
  subAgentType: string | null | undefined;
  description: string | null | undefined;
  ds: DetailStyles;
  itemId?: string;
}

interface SubAgentActivityRow {
  index: number;
  toolName: string;
  summary?: string;
}

interface ParsedSubAgentLog {
  actions: SubAgentActivityRow[];
  remainingLog: string;
}

function parseBracketedSubAgentLine(line: string, index: number): SubAgentActivityRow | null {
  const match = line.match(/^\[([^\]]+)\](?:\s+(.*))?$/);
  if (!match) {
    return null;
  }
  const toolName = match[1]?.trim();
  if (!toolName) {
    return null;
  }
  const summary = match[2]?.trim();
  return {
    index,
    toolName,
    ...(summary ? { summary } : {}),
  };
}

function parseSubAgentLog(log: string): ParsedSubAgentLog {
  const actions: SubAgentActivityRow[] = [];
  const remainingLines: string[] = [];
  for (const line of log.replace(/^\n+/, "").split("\n")) {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      continue;
    }
    const parsedAction = parseBracketedSubAgentLine(normalizedLine, actions.length + 1);
    if (parsedAction) {
      actions.push(parsedAction);
    } else {
      remainingLines.push(line);
    }
  }
  return {
    actions,
    remainingLog: remainingLines.join("\n").replace(/^\n+/, ""),
  };
}

function SubAgentActionRow({ action, itemId }: { action: SubAgentActivityRow; itemId?: string }) {
  return (
    <View style={styles.subAgentActionRow}>
      <Text selectable style={styles.subAgentActionTool}>
        {formatSubAgentToolName(action.toolName)}
      </Text>
      {action.summary ? (
        <Text selectable style={styles.subAgentActionSummary}>
          {/* action.summary is parsed out of the raw "toolOutput" log (see
              parseSubAgentLog) — its offsets no longer line up with the raw
              span, so this gets basic query highlighting but can't reliably
              go active; the block-level fallback anchor covers reveal. */}
          <HighlightedText text={action.summary} itemId={itemId} field="toolOutput" />
        </Text>
      ) : null}
    </View>
  );
}

function formatSubAgentToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return toolName;
  }
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function SubAgentLogText({
  activityLog,
  fallbackHeader,
  hasActions,
  itemId,
}: {
  activityLog: string;
  fallbackHeader: string;
  hasActions: boolean;
  itemId?: string;
}) {
  if (activityLog.length > 0) {
    return (
      <Text selectable style={styles.scrollText}>
        {/* remainingLog (see parseSubAgentLog) is the raw "toolOutput" log
            with bracketed action lines stripped out — offsets can drift from
            the raw span, same caveat as SubAgentActionRow above. */}
        <HighlightedText text={activityLog} itemId={itemId} field="toolOutput" />
      </Text>
    );
  }
  if (!hasActions) {
    return (
      <Text selectable style={styles.scrollText}>
        {/* fallbackHeader is a synthesized string (subAgentType + description),
            not any single field's own text — highlight the query in it, but
            don't wire itemId/field, which could otherwise coincidentally
            satisfy an unrelated match's offset and show a false "active" state. */}
        <HighlightedText text={fallbackHeader} />
      </Text>
    );
  }
  return null;
}

function SubAgentDetailSection({
  log,
  childSessionId,
  subAgentType,
  description,
  ds,
  itemId,
}: SubAgentDetailProps) {
  const { t } = useTranslation();
  const { actions, remainingLog } = useMemo(() => parseSubAgentLog(log), [log]);
  const fallbackHeader = resolveSubAgentFallbackHeader(
    subAgentType,
    description,
    t("toolCallDetails.subAgentActivity"),
  );
  const hasActions = actions.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              {childSessionId ? (
                <Text selectable style={styles.subAgentSessionText}>
                  session {childSessionId}
                </Text>
              ) : null}
              {hasActions ? (
                <View style={styles.subAgentActions}>
                  {actions.map((action) => (
                    <SubAgentActionRow key={action.index} action={action} itemId={itemId} />
                  ))}
                </View>
              ) : null}
              <SubAgentLogText
                activityLog={remainingLog}
                fallbackHeader={fallbackHeader}
                hasActions={hasActions}
                itemId={itemId}
              />
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

interface EditDetailProps {
  diffLines: DiffLine[] | undefined;
  ds: DetailStyles;
}

function EditDetailSection({ diffLines, ds }: EditDetailProps) {
  return (
    <View style={ds.sectionFillStyle}>
      {diffLines ? (
        <View style={ds.codeBlockFillStyle}>
          <DiffViewer
            diffLines={diffLines}
            maxHeight={ds.resolvedMaxHeight}
            fillAvailableHeight={ds.shouldFill}
          />
        </View>
      ) : null}
    </View>
  );
}

interface ScrollableContentProps {
  content: string;
  ds: DetailStyles;
  wrapInSectionFill?: boolean;
  // Drives syntax highlighting (extension only) and, with startLine, a gutter.
  filePath?: string | null;
  startLine?: number;
  itemId?: string;
  field?: TimelineSearchField;
}

function ScrollableTextSection({
  content,
  ds,
  wrapInSectionFill = true,
  filePath,
  startLine,
  itemId,
  field,
}: ScrollableContentProps) {
  const highlightQuery = useTimelineHighlightQuery();
  const keyedLines = useMemo(
    () => (filePath ? highlightToKeyedLines(content, extensionFromPath(filePath)) : null),
    [content, filePath],
  );
  const scrollRef = useRef<RNScrollView>(null);
  const fields = useMemo(() => (field ? [{ field, text: content }] : []), [content, field]);
  useRevealActiveToolDetailLine({
    scrollRef,
    itemId,
    fields,
  });
  const body = (
    <ScrollView
      ref={scrollRef}
      style={ds.scrollAreaFillStyle}
      contentContainerStyle={styles.scrollContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator={true}
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={true}>
        {keyedLines && highlightQuery.length === 0 ? (
          <HighlightedLines lines={keyedLines} startLine={startLine} />
        ) : (
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            <HighlightedText text={content} itemId={itemId} field={field} />
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
  if (!wrapInSectionFill) return body;
  return <View style={ds.sectionFillStyle}>{body}</View>;
}

interface FetchDetailProps {
  url: string;
  result: string | null | undefined;
  ds: DetailStyles;
  itemId?: string;
}

function FetchDetailSection({ url, result, ds, itemId }: FetchDetailProps) {
  const scrollRef = useRef<RNScrollView>(null);
  const fields = useMemo(
    () => [
      { field: "toolInput" as const, text: url },
      { field: "toolOutput" as const, text: result ?? "", startLine: 2 },
    ],
    [result, url],
  );
  useRevealActiveToolDetailLine({ scrollRef, itemId, fields });
  return (
    <View style={ds.sectionFillStyle}>
      <ScrollView
        ref={scrollRef}
        style={ds.scrollAreaFillStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            <HighlightedText text={url} itemId={itemId} field="toolInput" />
            {result
              ? [
                  "\n\n",
                  <HighlightedText key="result" text={result} itemId={itemId} field="toolOutput" />,
                ]
              : null}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function PlainTextSection({ text, itemId }: { text: string; itemId?: string }) {
  // detail.text is its own "toolInput" span (buildDetailInputParts's
  // "plain_text" case) — rendered verbatim here, so fieldOffset lines up.
  return (
    <View style={styles.plainTextSection}>
      <Text selectable style={styles.plainText}>
        <HighlightedText text={text} itemId={itemId} field="toolInput" />
      </Text>
    </View>
  );
}

interface SearchDetail {
  query?: string;
  content?: string;
  filePaths?: string[];
  webResults?: { title: string; url: string }[];
  annotations?: string[];
}

function buildSearchSections(detail: SearchDetail, ds: DetailStyles, itemId?: string): ReactNode[] {
  const out: ReactNode[] = [];
  if (detail.content) {
    out.push(
      <SearchContentSection
        key="search-content"
        content={detail.content}
        ds={ds}
        itemId={itemId}
      />,
    );
  }
  if (detail.filePaths && detail.filePaths.length > 0) {
    out.push(
      <View key="search-files" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {/* `filePaths` is part of the tool-input search span (joined with
              spaces by the model). The rendered separator differs, so this
              can provide the ordinary filtered highlight but must not claim an
              exact active occurrence. */}
          <HighlightedText text={detail.filePaths.join("\n")} itemId={itemId} field="toolInput" />
        </Text>
      </View>,
    );
  }
  if (detail.webResults && detail.webResults.length > 0) {
    out.push(
      <View key="search-web-results" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          <HighlightedText
            text={detail.webResults.map((entry) => `${entry.title}\n${entry.url}`).join("\n\n")}
          />
        </Text>
      </View>,
    );
  }
  if (detail.annotations && detail.annotations.length > 0) {
    out.push(
      <View key="search-annotations" style={styles.section}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          <HighlightedText text={detail.annotations.join("\n\n")} />
        </Text>
      </View>,
    );
  }
  return out;
}

function SearchContentSection({
  content,
  ds,
  itemId,
}: {
  content: string;
  ds: DetailStyles;
  itemId?: string;
}) {
  const scrollRef = useRef<RNScrollView>(null);
  const fields = useMemo(() => [{ field: "toolOutput" as const, text: content }], [content]);
  useRevealActiveToolDetailLine({ scrollRef, itemId, fields });
  return (
    <View key="search-content" style={styles.section}>
      <ScrollView
        ref={scrollRef}
        style={ds.scrollAreaStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            <HighlightedText text={content} itemId={itemId} field="toolOutput" />
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function serializeUnknownValue(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Mirrors the compact serialization used by the timeline search model. */
function serializeUnknownSearchSource(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

interface UnknownDetail {
  input: unknown;
  output: unknown;
}

function buildUnknownSections(
  detail: UnknownDetail,
  ds: DetailStyles,
  t: TFunction,
  timelineSearchItemId?: string,
): ReactNode[] {
  const plainInputText =
    typeof detail.input === "string" && detail.output === null ? detail.input : null;

  if (plainInputText !== null) {
    return [
      <View key="unknown-plain-text" style={styles.plainTextSection}>
        <Text selectable style={styles.plainText}>
          <HighlightedText text={plainInputText} itemId={timelineSearchItemId} field="toolInput" />
        </Text>
      </View>,
    ];
  }

  const sectionsFromTopLevel = [
    { title: t("toolCallDetails.input"), value: detail.input, field: "toolInput" as const },
    { title: t("toolCallDetails.output"), value: detail.output, field: "toolOutput" as const },
  ].filter((entry) =>
    hasMeaningfulToolCallDetail({
      type: "unknown",
      input: entry.value ?? null,
      output: null,
    }),
  );

  const out: ReactNode[] = [];
  for (const section of sectionsFromTopLevel) {
    const value = serializeUnknownValue(section.value);
    const sourceText = serializeUnknownSearchSource(section.value);
    if (!value.length) {
      continue;
    }
    out.push(
      <View key={`${section.title}-header`} style={styles.groupHeader}>
        <Text style={styles.groupHeaderText}>{section.title}</Text>
      </View>,
    );
    out.push(
      <View key={`${section.title}-value`} style={styles.section}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={ds.jsonScrollCombined}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            <HighlightedText
              text={value}
              sourceText={sourceText}
              itemId={timelineSearchItemId}
              field={section.field}
            />
          </Text>
        </ScrollView>
      </View>,
    );
  }
  return out;
}

function buildDetailSections(
  detail: ToolCallDetail | undefined,
  diffLines: DiffLine[] | undefined,
  ds: DetailStyles,
  t: TFunction,
  timelineSearchItemId?: string,
): ReactNode[] {
  if (!detail) return [];
  if (detail.type === "shell") {
    return [
      <ShellDetailSection
        key="shell"
        command={detail.command}
        output={detail.output}
        ds={ds}
        itemId={timelineSearchItemId}
      />,
    ];
  }
  if (detail.type === "worktree_setup") {
    return [
      <WorktreeSetupDetailSection
        key="worktree-setup"
        log={detail.log}
        branchName={detail.branchName}
        worktreePath={detail.worktreePath}
        ds={ds}
        itemId={timelineSearchItemId}
      />,
    ];
  }
  if (detail.type === "sub_agent") {
    return [
      <SubAgentDetailSection
        key="sub-agent"
        log={detail.log}
        childSessionId={detail.childSessionId}
        subAgentType={detail.subAgentType}
        description={detail.description}
        ds={ds}
        itemId={timelineSearchItemId}
      />,
    ];
  }
  if (detail.type === "edit") {
    return [<EditDetailSection key="edit" diffLines={diffLines} ds={ds} />];
  }
  if (detail.type === "write") {
    return [
      <View key="write" style={ds.sectionFillStyle}>
        {detail.content ? (
          <ScrollableTextSection
            content={detail.content}
            ds={ds}
            wrapInSectionFill={false}
            filePath={detail.filePath}
            itemId={timelineSearchItemId}
            field="toolInput"
          />
        ) : null}
      </View>,
    ];
  }
  if (detail.type === "read") {
    if (!detail.content) return [];
    return [
      <ScrollableTextSection
        key="read"
        content={detail.content}
        ds={ds}
        filePath={detail.filePath}
        startLine={detail.offset ?? 1}
        itemId={timelineSearchItemId}
        field="toolOutput"
      />,
    ];
  }
  if (detail.type === "search") {
    return buildSearchSections(detail, ds, timelineSearchItemId);
  }
  if (detail.type === "fetch") {
    return [
      <FetchDetailSection
        key="fetch"
        url={detail.url}
        result={detail.result}
        ds={ds}
        itemId={timelineSearchItemId}
      />,
    ];
  }
  if (detail.type === "plain_text") {
    if (!detail.text) return [];
    return [<PlainTextSection key="plain-text" text={detail.text} itemId={timelineSearchItemId} />];
  }
  if (detail.type === "unknown") {
    return buildUnknownSections(detail, ds, t, timelineSearchItemId);
  }
  return [];
}

function ErrorSection({
  errorText,
  ds,
  itemId,
}: {
  errorText: string;
  ds: DetailStyles;
  itemId?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.section}>
      <Text style={SECTION_TITLE_ERROR_STYLE}>{t("toolCallDetails.error")}</Text>
      <ScrollView
        horizontal
        nestedScrollEnabled
        style={ds.jsonScrollErrorCombined}
        contentContainerStyle={styles.jsonContent}
        showsHorizontalScrollIndicator={true}
      >
        <Text selectable style={SCROLL_TEXT_ERROR_STYLE} dataSet={CODE_SURFACE_DATASET}>
          {/* errorText comes from buildToolCallPresentation, which may format
              the raw error differently than the model's own safeStringify —
              highlight the query, but exact active-match alignment isn't
              guaranteed here. */}
          <HighlightedText text={errorText} itemId={itemId} field="toolError" />
        </Text>
      </ScrollView>
    </View>
  );
}

function LoadingSkeleton({ containerStyle }: { containerStyle: StyleProp<ViewStyle> }) {
  return (
    <View style={containerStyle}>
      <View style={styles.loadingLineWide} />
      <View style={styles.loadingLineMedium} />
      <View style={styles.loadingLineShort} />
    </View>
  );
}

export function ToolCallDetailsContent({ ...props }: ToolCallDetailsContentProps) {
  return (
    <AppearanceStyleBoundary>
      <ToolCallDetailsContentInner {...props} />
    </AppearanceStyleBoundary>
  );
}

function ToolCallDetailsContentInner({
  detail,
  timelineSearchItemId,
  timelineSearchField: _timelineSearchField,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
  showLoadingSkeleton = false,
}: ToolCallDetailsContentProps) {
  const { t } = useTranslation();
  const searchTarget = useTimelineSearchTarget();
  // itemId-only: a tool call has several field spans (tool/toolInput/
  // toolOutput/toolError), any of which can be the active match, and several
  // detail renderers (diff/JSON/parsed sub-agent log) can't map an exact span
  // at all. This block-level anchor is the fallback for ALL of them — same
  // itemId-only pattern as AssistantMessage/UserMessage — so it must not also
  // require `searchTarget.field === timelineSearchField` (that coarse single
  // field, defaulted by the caller, would almost never match the field the
  // active occurrence actually landed in).
  const isSearchTarget =
    timelineSearchItemId != null && searchTarget?.itemId === timelineSearchItemId;
  const searchAnchorRef = useRef<View>(null);
  const measureSearchAnchor = useCallback((report: (centerY: number) => void) => {
    searchAnchorRef.current?.measureInWindow?.((_x, y, _width, height) => {
      report(y + height / 2);
    });
  }, []);
  // Some detail renderers transform the source into a diff, JSON or a nested
  // scroll surface. Their exact text span cannot be mapped safely, so this is
  // a lower-priority block fallback behind HighlightedText's exact anchor.
  useTimelineSearchOccurrenceAnchor(
    isSearchTarget ? (searchTarget ?? null) : null,
    measureSearchAnchor,
    1,
  );
  const resolvedMaxHeight = fillAvailableHeight ? undefined : (maxHeight ?? 300);
  const ds = useDetailStyles(detail, resolvedMaxHeight, fillAvailableHeight);
  const diffLines = useDiffLines(detail);

  const sections: ReactNode[] = buildDetailSections(detail, diffLines, ds, t, timelineSearchItemId);

  if (errorText) {
    sections.push(
      <ErrorSection key="error" errorText={errorText} ds={ds} itemId={timelineSearchItemId} />,
    );
  }

  if (sections.length === 0) {
    if (showLoadingSkeleton) {
      return <LoadingSkeleton containerStyle={ds.loadingContainerStyle} />;
    }
    return <Text style={styles.emptyStateText}>{t("toolCallDetails.empty")}</Text>;
  }

  return (
    <View ref={searchAnchorRef} style={ds.fullBleedContainerStyle}>
      {sections}
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    paddedContainer: {
      gap: theme.spacing[4],
      padding: 0,
    },
    fullBleedContainer: {
      gap: theme.spacing[2],
      padding: 0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
    },
    groupHeaderText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.normal,
    },
    section: {
      gap: theme.spacing[2],
    },
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    plainTextSection: {
      gap: theme.spacing[2],
      padding: theme.spacing[3],
    },
    plainText: {
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.base,
      color: theme.colors.foreground,
      lineHeight: 22,
      overflowWrap: "anywhere",
    },
    sectionTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
      fontWeight: theme.fontWeight.semibold,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    rangeText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.xs,
    },
    diffContainer: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      overflow: "hidden",
      backgroundColor: theme.colors.surface2,
    },
    fullBleedBlock: {
      borderWidth: 0,
      borderRadius: 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
    codeVerticalScroll: {},
    codeVerticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    codeHorizontalContent: {
      paddingRight: insets.extraRight,
    },
    codeLine: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    scrollArea: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    scrollContent: {
      padding: insets.padding,
    },
    scrollText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    subAgentSessionText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
      marginBottom: theme.spacing[2],
    },
    subAgentActions: {
      gap: theme.spacing[1],
      marginBottom: theme.spacing[2],
    },
    subAgentActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    subAgentActionTool: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
    },
    subAgentActionSummary: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
    },
    jsonScroll: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface2,
    },
    jsonScrollError: {
      borderColor: theme.colors.destructive,
    },
    jsonContent: {
      padding: insets.padding,
    },
    errorText: {
      color: theme.colors.destructive,
    },
    emptyStateText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      fontStyle: "italic",
    },
    loadingContainer: {
      gap: theme.spacing[2],
      padding: theme.spacing[3],
    },
    loadingLineWide: {
      height: 12,
      width: "100%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineMedium: {
      height: 12,
      width: "72%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineShort: {
      height: 12,
      width: "48%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
  };
});

const SECTION_TITLE_ERROR_STYLE = [styles.sectionTitle, styles.errorText];
const SCROLL_TEXT_ERROR_STYLE = [styles.scrollText, styles.errorText];
