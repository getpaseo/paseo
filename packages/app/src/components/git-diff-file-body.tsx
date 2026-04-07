import { memo, useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  Platform,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import { Paperclip } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  darkHighlightColors,
  lightHighlightColors,
  type HighlightStyle as HighlightStyleKey,
} from "@getpaseo/highlight";
import {
  type ParsedDiffFile,
  type DiffLine,
  type HighlightToken,
} from "@/hooks/use-checkout-diff-query";
import { Fonts } from "@/constants/theme";
import { buildSplitDiffRows, type SplitDiffDisplayLine, type SplitDiffRow } from "@/utils/diff-layout";
import { buildHunkLineChatReference } from "@/utils/chat-reference-token";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DiffScroll } from "./diff-scroll";

export type HunkChatActionMode = "hover" | "tap-reveal";

interface ChatReferenceButtonProps {
  accessibilityLabel: string;
  tooltipLabel: string;
  onPress: () => void;
  testID?: string;
}

export interface GitDiffFileBodyProps {
  file: ParsedDiffFile;
  layout: "unified" | "split";
  wrapLines: boolean;
  hunkActionMode: HunkChatActionMode;
  onClearArmedLine?: () => void;
  onAddHunkReference?: (reference: string) => void;
  onBodyHeightChange?: (path: string, height: number) => void;
  testID?: string;
}

type HighlightStyle = NonNullable<HighlightToken["style"]>;

type WrappedWebTextStyle = TextStyle & {
  whiteSpace?: "pre" | "pre-wrap";
  overflowWrap?: "normal" | "anywhere";
};

function getWrappedTextStyle(wrapLines: boolean): WrappedWebTextStyle | undefined {
  if (Platform.OS !== "web") {
    return undefined;
  }
  return wrapLines
    ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
    : { whiteSpace: "pre", overflowWrap: "normal" };
}

function HighlightedText({
  tokens,
  wrapLines = false,
}: {
  tokens: HighlightToken[];
  wrapLines?: boolean;
}) {
  const { theme } = useUnistyles();
  const isDark = theme.colorScheme === "dark";
  const lineHeight = theme.lineHeight.diff;

  const getTokenColor = (style: HighlightStyle | null): string => {
    const baseColor = isDark ? "#c9d1d9" : "#24292f";
    if (!style) return baseColor;
    const colors = isDark ? darkHighlightColors : lightHighlightColors;
    return colors[style as HighlightStyleKey] ?? baseColor;
  };

  return (
    <Text
      style={[
        styles.diffLineText,
        { lineHeight, ...getWrappedTextStyle(wrapLines) },
      ]}
    >
      {tokens.map((token, index) => (
        <Text key={index} style={{ color: getTokenColor(token.style), lineHeight }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

export function ChatReferenceButton({
  accessibilityLabel,
  tooltipLabel,
  onPress,
  testID,
}: ChatReferenceButtonProps) {
  const { theme } = useUnistyles();
  const iconSize = Platform.OS === "web" ? 14 : 16;

  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={({ hovered, pressed }) => [
            styles.chatReferenceButton,
            (hovered || pressed) && styles.chatReferenceButtonHovered,
          ]}
        >
          <Paperclip size={iconSize} color={theme.colors.foregroundMuted} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function DiffHunkHeaderRow({
  content,
  gutterWidth,
  testID,
}: {
  content: string;
  gutterWidth?: number;
  testID?: string;
}) {
  return (
    <View style={[styles.diffLineContainer, styles.headerLineContainer]} testID={testID}>
      {typeof gutterWidth === "number" ? (
        <View style={[styles.lineNumberGutter, { width: gutterWidth }]} />
      ) : null}
      <Text style={[styles.diffLineText, styles.headerLineText, styles.hunkHeaderText]}>
        {content}
      </Text>
    </View>
  );
}

function LineNumberGutterSlot({
  gutterWidth,
  lineNumber,
  showAction,
  lineType,
  onAddReference,
  onPressLineNumber,
  testID,
}: {
  gutterWidth: number;
  lineNumber: number | null;
  showAction: boolean;
  lineType: DiffLine["type"];
  onAddReference?: () => void;
  onPressLineNumber?: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const iconSize = Platform.OS === "web" ? 14 : 16;
  const canRevealAction = Boolean(onAddReference) || Boolean(onPressLineNumber);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (onPressLineNumber && !showAction) {
        onPressLineNumber?.();
        return;
      }
      onAddReference?.();
    },
    [onAddReference, onPressLineNumber, showAction],
  );
  const renderText = () => (
    <Text
      style={[
        styles.lineNumberText,
        lineType === "add" && styles.addLineNumberText,
        lineType === "remove" && styles.removeLineNumberText,
      ]}
    >
      {lineNumber != null ? String(lineNumber) : ""}
    </Text>
  );
  const renderAction = () => (
    <View style={styles.lineNumberGutterActionContent}>
      <Paperclip size={iconSize} color={theme.colors.foregroundMuted} />
    </View>
  );

  if (!canRevealAction) {
    return <View style={[styles.lineNumberGutter, { width: gutterWidth }]}>{renderText()}</View>;
  }

  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showAction ? "Add hunk to chat" : "Reveal add hunk action"}
          testID={showAction ? testID : undefined}
          onPress={handlePress}
          style={[styles.lineNumberGutter, { width: gutterWidth }]}
        >
          {({ hovered, pressed }) =>
            showAction || (Platform.OS === "web" && (hovered || pressed))
              ? renderAction()
              : renderText()
          }
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text style={styles.tooltipText}>Add hunk to chat</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function DiffLineView({
  line,
  lineNumber,
  gutterWidth,
  wrapLines,
  hunkActionMode,
  lineKey,
  armedLineKey,
  onArmLine,
  onAddHunkReference,
  testID,
}: {
  line: DiffLine;
  lineNumber: number | null;
  gutterWidth: number;
  wrapLines: boolean;
  hunkActionMode: HunkChatActionMode;
  lineKey: string;
  armedLineKey: string | null;
  onArmLine?: (lineKey: string) => void;
  onAddHunkReference?: () => void;
  testID?: string;
}) {
  if (line.type === "header") {
    return (
      <DiffHunkHeaderRow
        content={line.content || " "}
        gutterWidth={gutterWidth}
        testID={testID}
      />
    );
  }

  return (
    <Pressable
      onPress={
        hunkActionMode === "tap-reveal"
          ? () => {
              if (armedLineKey !== lineKey) {
                onArmLine?.(lineKey);
              }
            }
          : undefined
      }
      style={[
        styles.diffLineContainer,
        line.type === "add" && styles.addLineContainer,
        line.type === "remove" && styles.removeLineContainer,
        line.type === "context" && styles.contextLineContainer,
      ]}
      testID={testID}
    >
      {({ hovered, pressed }) => {
        const showHunkAction =
          Boolean(onAddHunkReference) &&
          (hunkActionMode === "tap-reveal"
            ? armedLineKey === lineKey
            : hovered || pressed);

        return (
          <>
            <LineNumberGutterSlot
              gutterWidth={gutterWidth}
              lineNumber={lineNumber}
              showAction={showHunkAction}
              lineType={line.type}
              onAddReference={onAddHunkReference}
              onPressLineNumber={
                hunkActionMode === "tap-reveal"
                  ? () => {
                      if (armedLineKey !== lineKey) {
                        onArmLine?.(lineKey);
                      }
                    }
                  : undefined
              }
              testID={testID ? `${testID}-add-to-chat` : undefined}
            />
            {line.tokens ? (
              <HighlightedText tokens={line.tokens} wrapLines={wrapLines} />
            ) : (
              <Text
                style={[
                  styles.diffLineText,
                  getWrappedTextStyle(wrapLines),
                  line.type === "add" && styles.addLineText,
                  line.type === "remove" && styles.removeLineText,
                  line.type === "context" && styles.contextLineText,
                ]}
              >
                {line.content || " "}
              </Text>
            )}
          </>
        );
      }}
    </Pressable>
  );
}

function SplitDiffCell({
  line,
  gutterWidth,
  wrapLines,
  hunkActionMode,
  isArmed,
  onArmLine,
  showFirstLineAction,
  onAddHunkReference,
  showDivider = false,
  testID,
}: {
  line: SplitDiffDisplayLine | null;
  gutterWidth: number;
  wrapLines: boolean;
  hunkActionMode?: HunkChatActionMode;
  isArmed?: boolean;
  onArmLine?: () => void;
  showFirstLineAction?: boolean;
  onAddHunkReference?: () => void;
  showDivider?: boolean;
  testID?: string;
}) {
  const cellContent = (showHunkAction: boolean) => (
    <>
      <LineNumberGutterSlot
        gutterWidth={gutterWidth}
        lineNumber={line?.lineNumber ?? null}
        showAction={showHunkAction}
        lineType={line?.type ?? "context"}
        onAddReference={onAddHunkReference}
        onPressLineNumber={hunkActionMode === "tap-reveal" ? onArmLine : undefined}
        testID={testID ? `${testID}-add-to-chat` : undefined}
      />
      {line?.tokens ? (
        <HighlightedText tokens={line.tokens} wrapLines={wrapLines} />
      ) : (
        <Text
          style={[
            styles.diffLineText,
            getWrappedTextStyle(wrapLines),
            line?.type === "add" && styles.addLineText,
            line?.type === "remove" && styles.removeLineText,
            line?.type === "context" && styles.contextLineText,
            !line && styles.emptySplitCellText,
          ]}
        >
          {line?.content ?? ""}
        </Text>
      )}
    </>
  );

  if (!line) {
    return (
      <View
        style={[
          styles.splitCell,
          showDivider && styles.splitCellWithDivider,
          styles.emptySplitCell,
        ]}
      >
        <View style={styles.splitCellRow}>{cellContent(false)}</View>
      </View>
    );
  }

  return (
    <Pressable
      style={[
        styles.splitCell,
        showDivider && styles.splitCellWithDivider,
        line.type === "add" && styles.addLineContainer,
        line.type === "remove" && styles.removeLineContainer,
        line.type === "context" && styles.contextLineContainer,
      ]}
      onPress={hunkActionMode === "tap-reveal" ? onArmLine : undefined}
      testID={testID}
    >
      {({ hovered, pressed }) => (
        <View style={styles.splitCellRow}>
          {cellContent(
            Boolean(onAddHunkReference) &&
              (hunkActionMode === "tap-reveal"
                ? Boolean(showFirstLineAction) && Boolean(isArmed)
                : hovered || pressed),
          )}
        </View>
      )}
    </Pressable>
  );
}

function SplitDiffRowView({
  row,
  gutterWidth,
  wrapLines,
  hunkActionMode,
  armedLineKey,
  onArmLine,
  onAddHunkReference,
  testID,
}: {
  row: Extract<SplitDiffRow, { kind: "pair" }>;
  gutterWidth: number;
  wrapLines: boolean;
  hunkActionMode: HunkChatActionMode;
  armedLineKey: string | null;
  onArmLine?: (lineKey: string) => void;
  onAddHunkReference?: () => void;
  testID?: string;
}) {
  const leftLineKey = row.left ? `${testID ?? "split-row"}:left` : null;
  const rightLineKey = row.right ? `${testID ?? "split-row"}:right` : null;

  return (
    <View style={styles.splitRow} testID={testID}>
      <SplitDiffCell
        line={row.left}
        gutterWidth={gutterWidth}
        wrapLines={wrapLines}
        hunkActionMode={hunkActionMode}
        isArmed={leftLineKey !== null && armedLineKey === leftLineKey}
        onArmLine={
          leftLineKey && onArmLine
            ? () => {
                onArmLine(leftLineKey);
              }
            : undefined
        }
        showFirstLineAction={row.isFirstChangedLineInHunk && row.left !== null}
        onAddHunkReference={onAddHunkReference}
        testID={testID ? `${testID}-left` : undefined}
      />
      <SplitDiffCell
        line={row.right}
        gutterWidth={gutterWidth}
        wrapLines={wrapLines}
        hunkActionMode={hunkActionMode}
        isArmed={rightLineKey !== null && armedLineKey === rightLineKey}
        onArmLine={
          rightLineKey && onArmLine
            ? () => {
                onArmLine(rightLineKey);
              }
            : undefined
        }
        showFirstLineAction={
          row.isFirstChangedLineInHunk && row.left === null && row.right !== null
        }
        onAddHunkReference={onAddHunkReference}
        showDivider
        testID={testID ? `${testID}-right` : undefined}
      />
    </View>
  );
}

interface UnifiedDiffRenderRow {
  hunkIndex: number;
  lineIndex: number;
  line: DiffLine;
  lineNumber: number | null;
  lineKey: string;
  reference: string | null;
}

const GitDiffFileBody = memo(function GitDiffFileBody({
  file,
  layout,
  wrapLines,
  hunkActionMode,
  onClearArmedLine,
  onAddHunkReference,
  onBodyHeightChange,
  testID,
}: GitDiffFileBodyProps) {
  const [armedLineKey, setArmedLineKey] = useState<string | null>(null);
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);
  const gutterWidth = useMemo(() => {
    let maxLineNo = 0;
    for (const hunk of file.hunks) {
      maxLineNo = Math.max(maxLineNo, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    }
    return lineNumberGutterWidth(maxLineNo);
  }, [file]);
  const splitRows = useMemo(() => buildSplitDiffRows(file), [file]);
  const unifiedRows = useMemo<UnifiedDiffRenderRow[]>(() => {
    const rows: UnifiedDiffRenderRow[] = [];

    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      let oldLineNo = hunk.oldStart;
      let newLineNo = hunk.newStart;

      for (const [lineIndex, line] of hunk.lines.entries()) {
        let lineNumber: number | null = null;
        if (line.type === "remove") {
          lineNumber = oldLineNo;
          oldLineNo += 1;
        } else if (line.type === "add") {
          lineNumber = newLineNo;
          newLineNo += 1;
        } else if (line.type === "context") {
          lineNumber = newLineNo;
          oldLineNo += 1;
          newLineNo += 1;
        }

        rows.push({
          hunkIndex,
          lineIndex,
          line,
          lineNumber,
          lineKey: `${file.path}:${hunkIndex}:${lineIndex}`,
          reference:
            line.type === "header"
              ? null
              : buildHunkLineChatReference({
                  path: file.path,
                  hunk,
                  lineIndex,
                }),
        });
      }
    }

    return rows;
  }, [file]);
  const handleArmLine = useCallback((lineKey: string) => {
    setArmedLineKey((current) => (current === lineKey ? current : lineKey));
  }, []);
  const handleClearArmedLine = useCallback(() => {
    setArmedLineKey(null);
    onClearArmedLine?.();
  }, [onClearArmedLine]);

  return (
    <View
      style={[styles.fileSectionBodyContainer, styles.fileSectionBorder]}
      onLayout={(event: LayoutChangeEvent) => {
        setBodyWidth(event.nativeEvent.layout.width);
        onBodyHeightChange?.(file.path, event.nativeEvent.layout.height);
      }}
      testID={testID}
    >
      {(() => {
        if (file.status === "too_large" || file.status === "binary") {
          return (
            <View style={styles.statusMessageContainer}>
              <Text style={styles.statusMessageText}>
                {file.status === "binary" ? "Binary file" : "Diff too large to display"}
              </Text>
            </View>
          );
        }

        const linesContent =
          layout === "split"
            ? splitRows.map((row, rowIndex) => {
                if (row.kind === "header") {
                  return (
                    <View key={`header-${rowIndex}`} style={styles.splitHeaderRow}>
                      <DiffHunkHeaderRow
                        content={row.content}
                        testID={testID ? `${testID}-hunk-${rowIndex}` : undefined}
                      />
                    </View>
                  );
                }

                return (
                  <SplitDiffRowView
                    key={`pair-${rowIndex}`}
                    row={row}
                    gutterWidth={gutterWidth}
                    wrapLines={wrapLines}
                    hunkActionMode={hunkActionMode}
                    armedLineKey={armedLineKey}
                    onArmLine={handleArmLine}
                    onAddHunkReference={
                      onAddHunkReference ? () => onAddHunkReference(row.chatReference) : undefined
                    }
                    testID={testID ? `${testID}-hunk-${rowIndex}` : undefined}
                  />
                );
              })
            : unifiedRows.map((row) => {
                const reference = row.reference;
                return (
                  <DiffLineView
                    key={`${row.hunkIndex}-${row.lineIndex}`}
                    line={row.line}
                    lineNumber={row.lineNumber}
                    gutterWidth={gutterWidth}
                    wrapLines={wrapLines}
                    hunkActionMode={hunkActionMode}
                    lineKey={row.lineKey}
                    armedLineKey={armedLineKey}
                    onArmLine={handleArmLine}
                    onAddHunkReference={
                      reference && onAddHunkReference
                        ? () => {
                            onAddHunkReference(reference);
                            handleClearArmedLine();
                          }
                        : undefined
                    }
                    testID={testID ? `${testID}-hunk-${row.hunkIndex}-line-${row.lineIndex}` : undefined}
                  />
                );
              });

        const availableWidth = bodyWidth > 0 ? bodyWidth : scrollViewWidth;
        const contentContainer = (
          <View
            style={[
              layout === "split" ? styles.splitLinesContainer : styles.linesContainer,
              availableWidth > 0 &&
                (layout === "split"
                  ? { width: availableWidth, minWidth: availableWidth, maxWidth: availableWidth }
                  : { minWidth: availableWidth }),
            ]}
          >
            {linesContent}
          </View>
        );

        if (wrapLines) {
          return <View style={styles.diffContent}>{contentContainer}</View>;
        }
        return (
          <DiffScroll
            scrollViewWidth={scrollViewWidth}
            onScrollViewWidthChange={setScrollViewWidth}
            onScroll={hunkActionMode === "tap-reveal" ? handleClearArmedLine : undefined}
            style={styles.diffContent}
            contentContainerStyle={styles.diffContentInner}
          >
            {contentContainer}
          </DiffScroll>
        );
      })()}
    </View>
  );
});

export { GitDiffFileBody };

const styles = StyleSheet.create((theme) => ({
  fileSectionBodyContainer: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  fileSectionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  diffContentInner: {
    flexDirection: "column",
  },
  linesContainer: {
    backgroundColor: theme.colors.surface1,
  },
  splitLinesContainer: {
    backgroundColor: theme.colors.surface1,
    minWidth: 760,
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  splitHeaderRow: {
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
  },
  splitCell: {
    flex: 1,
    flexBasis: 0,
    backgroundColor: theme.colors.surface2,
  },
  splitCellRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  emptySplitCell: {
    backgroundColor: theme.colors.surfaceDiffEmpty,
  },
  splitCellWithDivider: {
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  diffLineContainer: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  lineNumberGutter: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    marginRight: theme.spacing[2],
    alignSelf: "stretch",
    justifyContent: "flex-start",
  },
  lineNumberGutterActionContent: {
    height: theme.lineHeight.diff,
    alignSelf: "stretch",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingRight: theme.spacing[2],
  },
  lineNumberText: {
    textAlign: "right",
    paddingRight: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.lineHeight.diff,
    fontFamily: Fonts.mono,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  addLineNumberText: {
    color: theme.colors.palette.green[400],
  },
  removeLineNumberText: {
    color: theme.colors.palette.red[500],
  },
  diffLineText: {
    flex: 1,
    paddingRight: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.lineHeight.diff,
    fontFamily: Fonts.mono,
    color: theme.colors.foreground,
    userSelect: "text",
  },
  addLineContainer: {
    backgroundColor: "rgba(46, 160, 67, 0.15)",
  },
  addLineText: {
    color: theme.colors.foreground,
  },
  removeLineContainer: {
    backgroundColor: "rgba(248, 81, 73, 0.1)",
  },
  removeLineText: {
    color: theme.colors.foreground,
  },
  headerLineContainer: {
    backgroundColor: theme.colors.surface2,
  },
  headerLineText: {
    color: theme.colors.foregroundMuted,
  },
  hunkHeaderText: {
    flexShrink: 1,
    paddingRight: theme.spacing[2],
  },
  contextLineContainer: {
    backgroundColor: theme.colors.surface1,
  },
  contextLineText: {
    color: theme.colors.foregroundMuted,
  },
  chatReferenceButton: {
    alignItems: "center",
    justifyContent: "center",
    width: {
      xs: 28,
      sm: 28,
      md: 24,
    },
    height: {
      xs: 28,
      sm: 28,
      md: 24,
    },
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  chatReferenceButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  emptySplitCellText: {
    color: "transparent",
  },
  statusMessageContainer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  statusMessageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
