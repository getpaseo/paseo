import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  memo,
  type ReactElement,
} from "react";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  Platform,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  TextStyle,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import {
  AlignJustify,
  Archive,
  ChevronDown,
  Columns2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Paperclip,
  Pilcrow,
  RefreshCcw,
  Upload,
  WrapText,
} from "lucide-react-native";
import { useCheckoutGitActionsStore } from "@/stores/checkout-git-actions-store";
import {
  useCheckoutDiffQuery,
  type ParsedDiffFile,
  type DiffLine,
  type HighlightToken,
} from "@/hooks/use-checkout-diff-query";
import { useCheckoutStatusQuery } from "@/hooks/use-checkout-status-query";
import { useCheckoutPrStatusQuery } from "@/hooks/use-checkout-pr-status-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { DiffScroll } from "./diff-scroll";
import {
  darkHighlightColors,
  lightHighlightColors,
  type HighlightStyle as HighlightStyleKey,
} from "@getpaseo/highlight";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { Fonts } from "@/constants/theme";
import { shouldAnchorHeaderBeforeCollapse } from "@/utils/git-diff-scroll";
import {
  buildSplitDiffRows,
  type SplitDiffDisplayLine,
  type SplitDiffRow,
} from "@/utils/diff-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { GitHubIcon } from "@/components/icons/github-icon";
import { buildGitActions, type GitActions } from "@/components/git-actions-policy";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";
import { buildNewAgentRoute, resolveNewAgentWorkingDir } from "@/utils/new-agent-routing";
import { openExternalUrl } from "@/utils/open-external-url";
import { GitActionsSplitButton } from "@/components/git-actions-split-button";
import { useToast } from "@/contexts/toast-context";
import { appendTextTokenToComposer, insertIntoActiveChatComposer } from "@/utils/active-chat-composer";
import {
  buildFileChatReference,
  buildHunkLineChatReference,
} from "@/utils/chat-reference-token";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { usePanelStore } from "@/stores/panel-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";

export type { GitActionId, GitAction, GitActions } from "@/components/git-actions-policy";

function openURLInNewTab(url: string): void {
  void openExternalUrl(url);
}

type HighlightStyle = NonNullable<HighlightToken["style"]>;

interface HighlightedTextProps {
  tokens: HighlightToken[];
  wrapLines?: boolean;
}

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

function HighlightedText({ tokens, wrapLines = false }: HighlightedTextProps) {
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

interface DiffFileSectionProps {
  file: ParsedDiffFile;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  onAddFileReference?: (file: ParsedDiffFile) => void;
  onClearArmedLine?: () => void;
  onHeaderHeightChange?: (path: string, height: number) => void;
  testID?: string;
}

interface ChatReferenceButtonProps {
  accessibilityLabel: string;
  tooltipLabel: string;
  onPress: () => void;
  testID?: string;
}

type HunkChatActionMode = "hover" | "tap-reveal";

function ChatReferenceButton({
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
  onHoverLine,
  onLeaveLine,
  testID,
}: {
  gutterWidth: number;
  lineNumber: number | null;
  showAction: boolean;
  lineType: DiffLine["type"];
  onAddReference?: () => void;
  onPressLineNumber?: () => void;
  onHoverLine?: () => void;
  onLeaveLine?: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const iconSize = Platform.OS === "web" ? 14 : 16;
  const isInteractive = Boolean(onAddReference) && showAction;
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onAddReference?.();
    },
    [onAddReference],
  );

  return (
    <Tooltip
      delayDuration={300}
      enabledOnDesktop={isInteractive}
      enabledOnMobile={false}
    >
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole={isInteractive ? "button" : undefined}
          accessibilityLabel={isInteractive ? "Add hunk to chat" : undefined}
          testID={isInteractive ? testID : undefined}
          onPress={isInteractive ? handlePress : onPressLineNumber}
          onHoverIn={Platform.OS === "web" ? onHoverLine : undefined}
          onHoverOut={Platform.OS === "web" ? onLeaveLine : undefined}
          style={({ pressed }) => [
            styles.lineNumberGutter,
            { width: gutterWidth },
            isInteractive && pressed && styles.chatReferenceButtonHovered,
          ]}
        >
          {isInteractive ? (
            <View style={styles.lineNumberGutterActionContent}>
              <Paperclip size={iconSize} color={theme.colors.foregroundMuted} />
            </View>
          ) : (
            <Text
              style={[
                styles.lineNumberText,
                lineType === "add" && styles.addLineNumberText,
                lineType === "remove" && styles.removeLineNumberText,
              ]}
            >
              {lineNumber != null ? String(lineNumber) : ""}
            </Text>
          )}
        </Pressable>
      </TooltipTrigger>
      {isInteractive ? (
        <TooltipContent side="top">
          <Text style={styles.tooltipText}>Add hunk to chat</Text>
        </TooltipContent>
      ) : null}
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
  hoveredLineKey,
  onHoverLine,
  onLeaveLine,
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
  hoveredLineKey: string | null;
  onHoverLine?: (lineKey: string) => void;
  onLeaveLine?: () => void;
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
      onHoverIn={Platform.OS === "web" ? () => onHoverLine?.(lineKey) : undefined}
      onHoverOut={Platform.OS === "web" ? onLeaveLine : undefined}
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
            : hoveredLineKey === lineKey || hovered || pressed);

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
              onHoverLine={hunkActionMode === "hover" ? () => onHoverLine?.(lineKey) : undefined}
              onLeaveLine={hunkActionMode === "hover" ? onLeaveLine : undefined}
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
  lineKey,
  hoveredLineKey,
  onHoverLine,
  onLeaveLine,
  showFirstLineAction,
  onAddHunkReference,
  showDivider = false,
  testID,
}: {
  line: SplitDiffDisplayLine | null;
  gutterWidth: number;
  wrapLines: boolean;
  hunkActionMode?: HunkChatActionMode;
  lineKey?: string;
  hoveredLineKey: string | null;
  onHoverLine?: (lineKey: string) => void;
  onLeaveLine?: () => void;
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
        onHoverLine={
          hunkActionMode === "hover" && lineKey ? () => onHoverLine?.(lineKey) : undefined
        }
        onLeaveLine={hunkActionMode === "hover" ? onLeaveLine : undefined}
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
        line?.type === "add" && styles.addLineContainer,
        line?.type === "remove" && styles.removeLineContainer,
        line?.type === "context" && styles.contextLineContainer,
      ]}
      onHoverIn={
        Platform.OS === "web" && lineKey ? () => onHoverLine?.(lineKey) : undefined
      }
      onHoverOut={Platform.OS === "web" ? onLeaveLine : undefined}
      testID={testID}
    >
      {({ hovered, pressed }) =>
        (
          <View style={styles.splitCellRow}>
            {cellContent(
              Boolean(onAddHunkReference) &&
                (hunkActionMode === "tap-reveal"
                  ? Boolean(showFirstLineAction)
                  : hoveredLineKey === lineKey || hovered || pressed),
            )}
          </View>
        )
      }
    </Pressable>
  );
}

function SplitDiffRowView({
  row,
  gutterWidth,
  wrapLines,
  hunkActionMode,
  hoveredLineKey,
  onHoverLine,
  onLeaveLine,
  onAddHunkReference,
  testID,
}: {
  row: Extract<SplitDiffRow, { kind: "pair" }>;
  gutterWidth: number;
  wrapLines: boolean;
  hunkActionMode: HunkChatActionMode;
  hoveredLineKey: string | null;
  onHoverLine?: (lineKey: string) => void;
  onLeaveLine?: () => void;
  onAddHunkReference?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.splitRow} testID={testID}>
      <SplitDiffCell
        line={row.left}
        gutterWidth={gutterWidth}
        wrapLines={wrapLines}
        hunkActionMode={hunkActionMode}
        lineKey={row.left ? `${testID ?? "split-row"}:left` : undefined}
        hoveredLineKey={hoveredLineKey}
        onHoverLine={onHoverLine}
        onLeaveLine={onLeaveLine}
        showFirstLineAction={row.isFirstChangedLineInHunk && row.left !== null}
        onAddHunkReference={onAddHunkReference}
        testID={testID ? `${testID}-left` : undefined}
      />
      <SplitDiffCell
        line={row.right}
        gutterWidth={gutterWidth}
        wrapLines={wrapLines}
        hunkActionMode={hunkActionMode}
        lineKey={row.right ? `${testID ?? "split-row"}:right` : undefined}
        hoveredLineKey={hoveredLineKey}
        onHoverLine={onHoverLine}
        onLeaveLine={onLeaveLine}
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

const DiffFileHeader = memo(function DiffFileHeader({
  file,
  isExpanded,
  onToggle,
  onAddFileReference,
  onClearArmedLine,
  onHeaderHeightChange,
  testID,
}: DiffFileSectionProps) {
  const layoutYRef = useRef<number | null>(null);
  const pressHandledRef = useRef(false);
  const pressInRef = useRef<{ ts: number; pageX: number; pageY: number } | null>(null);

  const toggleExpanded = useCallback(() => {
    pressHandledRef.current = true;
    onClearArmedLine?.();
    onToggle(file.path);
  }, [file.path, onClearArmedLine, onToggle]);

  return (
    <View
      style={[styles.fileSectionHeaderContainer, isExpanded && styles.fileSectionHeaderExpanded]}
      onLayout={(event) => {
        layoutYRef.current = event.nativeEvent.layout.y;
        onHeaderHeightChange?.(file.path, event.nativeEvent.layout.height);
      }}
      testID={testID}
    >
      <View style={styles.fileHeaderRow}>
        <Pressable
          testID={testID ? `${testID}-toggle` : undefined}
          style={({ pressed }) => [styles.fileHeader, pressed && styles.fileHeaderPressed]}
          // Android: prevent parent pan/scroll gestures from canceling the tap release.
          cancelable={false}
          onPressIn={(event) => {
            pressHandledRef.current = false;
            pressInRef.current = {
              ts: Date.now(),
              pageX: event.nativeEvent.pageX,
              pageY: event.nativeEvent.pageY,
            };
          }}
          onPressOut={(event) => {
            if (
              Platform.OS !== "web" &&
              !pressHandledRef.current &&
              layoutYRef.current === 0 &&
              pressInRef.current
            ) {
              const durationMs = Date.now() - pressInRef.current.ts;
              const dx = event.nativeEvent.pageX - pressInRef.current.pageX;
              const dy = event.nativeEvent.pageY - pressInRef.current.pageY;
              const distance = Math.hypot(dx, dy);
              // Sticky headers on Android can emit pressIn/pressOut without onPress.
              // Treat short, low-movement interactions as taps.
              if (durationMs <= 500 && distance <= 12) {
                toggleExpanded();
              }
            }
          }}
          onPress={toggleExpanded}
        >
          <View style={styles.fileHeaderLeft}>
            <Text style={styles.fileName}>{file.path.split("/").pop()}</Text>
            <Text style={styles.fileDir} numberOfLines={1}>
              {file.path.includes("/") ? ` ${file.path.slice(0, file.path.lastIndexOf("/"))}` : ""}
            </Text>
            {file.isNew && (
              <View style={styles.newBadge}>
                <Text style={styles.newBadgeText}>New</Text>
              </View>
            )}
            {file.isDeleted && (
              <View style={styles.deletedBadge}>
                <Text style={styles.deletedBadgeText}>Deleted</Text>
              </View>
            )}
          </View>
          <View style={styles.fileHeaderRight}>
            <Text style={styles.additions}>+{file.additions}</Text>
            <Text style={styles.deletions}>-{file.deletions}</Text>
          </View>
        </Pressable>
        {onAddFileReference ? (
          <ChatReferenceButton
            accessibilityLabel="Add file to chat"
            tooltipLabel="Add file to chat"
            onPress={() => {
              onClearArmedLine?.();
              onAddFileReference(file);
            }}
            testID={testID ? `${testID}-add-to-chat` : undefined}
          />
        ) : null}
      </View>
    </View>
  );
});

function DiffFileBody({
  file,
  layout,
  wrapLines,
  hunkActionMode,
  hoveredLineKey,
  onHoverLine,
  onLeaveLine,
  armedLineKey,
  onArmLine,
  onClearArmedLine,
  onAddHunkReference,
  onBodyHeightChange,
  testID,
}: {
  file: ParsedDiffFile;
  layout: "unified" | "split";
  wrapLines: boolean;
  hunkActionMode: HunkChatActionMode;
  hoveredLineKey: string | null;
  onHoverLine?: (lineKey: string) => void;
  onLeaveLine?: () => void;
  armedLineKey: string | null;
  onArmLine?: (lineKey: string) => void;
  onClearArmedLine?: () => void;
  onAddHunkReference?: (reference: string) => void;
  onBodyHeightChange?: (path: string, height: number) => void;
  testID?: string;
}) {
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);

  return (
    <View
      style={[styles.fileSectionBodyContainer, styles.fileSectionBorder]}
      onLayout={(event) => {
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

        let maxLineNo = 0;
        for (const hunk of file.hunks) {
          maxLineNo = Math.max(maxLineNo, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
        }
        const gutterWidth = lineNumberGutterWidth(maxLineNo);

        const linesContent =
          layout === "split"
            ? buildSplitDiffRows(file).map((row, rowIndex) => {
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
                    hoveredLineKey={hoveredLineKey}
                    onHoverLine={onHoverLine}
                    onLeaveLine={onLeaveLine}
                    onAddHunkReference={
                      onAddHunkReference
                        ? () => onAddHunkReference(row.chatReference)
                        : undefined
                    }
                    testID={testID ? `${testID}-hunk-${rowIndex}` : undefined}
                  />
                );
              })
            : file.hunks.map((hunk, hunkIndex) => {
                let oldLineNo = hunk.oldStart;
                let newLineNo = hunk.newStart;
                return hunk.lines.map((line, lineIndex) => {
                  let lineNumber: number | null = null;
                  if (line.type === "remove") {
                    lineNumber = oldLineNo;
                    oldLineNo++;
                  } else if (line.type === "add") {
                    lineNumber = newLineNo;
                    newLineNo++;
                  } else if (line.type === "context") {
                    lineNumber = newLineNo;
                    oldLineNo++;
                    newLineNo++;
                  }
                  const currentLineKey = `${file.path}:${hunkIndex}:${lineIndex}`;
                  return (
                    <DiffLineView
                      key={`${hunkIndex}-${lineIndex}`}
                      line={line}
                      lineNumber={lineNumber}
                      gutterWidth={gutterWidth}
                      wrapLines={wrapLines}
                      hunkActionMode={hunkActionMode}
                      lineKey={currentLineKey}
                      hoveredLineKey={hoveredLineKey}
                      onHoverLine={onHoverLine}
                      onLeaveLine={onLeaveLine}
                      armedLineKey={armedLineKey}
                      onArmLine={onArmLine}
                      onAddHunkReference={
                        line.type !== "header" && onAddHunkReference
                          ? () =>
                              {
                                onAddHunkReference(
                                  buildHunkLineChatReference({
                                    path: file.path,
                                    hunk,
                                    lineIndex,
                                  }),
                                );
                                onClearArmedLine?.();
                              }
                          : undefined
                      }
                      testID={testID ? `${testID}-hunk-${hunkIndex}-line-${lineIndex}` : undefined}
                    />
                  );
                });
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
            onScroll={hunkActionMode === "tap-reveal" ? onClearArmedLine : undefined}
            style={styles.diffContent}
            contentContainerStyle={styles.diffContentInner}
          >
            {contentContainer}
          </DiffScroll>
        );
      })()}
    </View>
  );
}

interface GitDiffPaneProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  hideHeaderRow?: boolean;
}

type DiffFlatItem =
  | { type: "header"; file: ParsedDiffFile; fileIndex: number; isExpanded: boolean }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number };

export function GitDiffPane({ serverId, workspaceId, cwd, hideHeaderRow }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const showDesktopWebScrollbar = Platform.OS === "web" && !isMobile;
  const canUseSplitLayout = Platform.OS === "web" && !isMobile;
  const hunkActionMode: HunkChatActionMode =
    Platform.OS === "web" && !isMobile ? "hover" : "tap-reveal";
  const router = useRouter();
  const toast = useToast();
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const [hoveredLineKey, setHoveredLineKey] = useState<string | null>(null);
  const [armedLineKey, setArmedLineKey] = useState<string | null>(null);
  const [diffModeOverride, setDiffModeOverride] = useState<"uncommitted" | "base" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [postShipArchiveSuggested, setPostShipArchiveSuggested] = useState(false);
  const [shipDefault, setShipDefault] = useState<"merge" | "pr">("merge");
  const { preferences: changesPreferences, updatePreferences: updateChangesPreferences } =
    useChangesPreferences();
  const wrapLines = changesPreferences.wrapLines;
  const effectiveLayout = canUseSplitLayout ? changesPreferences.layout : "unified";

  const handleToggleWrapLines = useCallback(() => {
    void updateChangesPreferences({ wrapLines: !wrapLines });
  }, [updateChangesPreferences, wrapLines]);

  const handleLayoutChange = useCallback(
    (nextLayout: "unified" | "split") => {
      void updateChangesPreferences({ layout: nextLayout });
    },
    [updateChangesPreferences],
  );

  const handleToggleHideWhitespace = useCallback(() => {
    void updateChangesPreferences({ hideWhitespace: !changesPreferences.hideWhitespace });
  }, [changesPreferences.hideWhitespace, updateChangesPreferences]);

  const handleInsertChatReference = useCallback(
    (reference: string) => {
      if (insertIntoActiveChatComposer(reference)) {
        if (isMobile) {
          closeToAgent();
        }
        return;
      }

      const resolvedWorkspaceId = workspaceId?.trim() || cwd.trim();
      if (!resolvedWorkspaceId) {
        toast.error("Open a chat first");
        return;
      }

      const draftId = generateDraftId();
      const draftKey = buildDraftStoreKey({
        serverId,
        agentId: draftId,
        draftId,
      });
      useDraftStore.getState().saveDraftInput({
        draftKey,
        draft: {
          text: appendTextTokenToComposer({ value: "", token: reference }),
          images: [],
        },
      });

      const route = prepareWorkspaceTab({
        serverId,
        workspaceId: resolvedWorkspaceId,
        target: { kind: "draft", draftId },
      });
      if (isMobile) {
        closeToAgent();
      }
      router.navigate(route as any);
    },
    [closeToAgent, cwd, isMobile, router, serverId, toast, workspaceId],
  );

  const handleAddFileReference = useCallback(
    (file: ParsedDiffFile) => {
      handleInsertChatReference(buildFileChatReference(file.path));
    },
    [handleInsertChatReference],
  );

  const handleAddHunkReference = useCallback(
    (reference: string) => {
      handleInsertChatReference(reference);
    },
    [handleInsertChatReference],
  );

  const {
    status,
    isLoading: isStatusLoading,
    isFetching: isStatusFetching,
    isError: isStatusError,
    error: statusError,
    refresh: refreshStatus,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;

  // Auto-select diff mode based on state: uncommitted when dirty, base when clean
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const autoDiffMode = hasUncommittedChanges ? "uncommitted" : "base";
  const diffMode = diffModeOverride ?? autoDiffMode;

  const {
    files,
    payloadError: diffPayloadError,
    isLoading: isDiffLoading,
    isFetching: isDiffFetching,
    isError: isDiffError,
    error: diffError,
    refresh: refreshDiff,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    ignoreWhitespace: changesPreferences.hideWhitespace,
    enabled: isGit,
  });
  const {
    status: prStatus,
    githubFeaturesEnabled,
    payloadError: prPayloadError,
    refresh: refreshPrStatus,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  // Track user-initiated refresh to avoid iOS RefreshControl animation on background fetches
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const normalizedWorkspaceRoot = useMemo(() => cwd.trim(), [cwd]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.diffExpandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setDiffExpandedPathsForWorkspace = usePanelStore(
    (state) => state.setDiffExpandedPathsForWorkspace,
  );
  const expandedPaths = useMemo(
    () => new Set(expandedPathsArray ?? []),
    [expandedPathsArray],
  );
  const diffListRef = useRef<FlatList<DiffFlatItem>>(null);
  const scrollbar = useWebScrollViewScrollbar(diffListRef, {
    enabled: showDesktopWebScrollbar,
  });
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByPathRef = useRef<Record<string, number>>({});
  const defaultHeaderHeightRef = useRef<number>(44);
  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshDiff();
    void refreshStatus();
    void refreshPrStatus();
  }, [refreshDiff, refreshStatus, refreshPrStatus]);

  const shipDefaultStorageKey = useMemo(() => {
    if (!gitStatus?.repoRoot) {
      return null;
    }
    return `@paseo:changes-ship-default:${gitStatus.repoRoot}`;
  }, [gitStatus?.repoRoot]);

  useEffect(() => {
    if (!shipDefaultStorageKey) {
      return;
    }
    let isActive = true;
    AsyncStorage.getItem(shipDefaultStorageKey)
      .then((value) => {
        if (!isActive) return;
        if (value === "pr" || value === "merge") {
          setShipDefault(value);
        }
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [shipDefaultStorageKey]);

  const persistShipDefault = useCallback(
    async (next: "merge" | "pr") => {
      setShipDefault(next);
      if (!shipDefaultStorageKey) return;
      try {
        await AsyncStorage.setItem(shipDefaultStorageKey, next);
      } catch {
        // Ignore persistence failures; default will reset to "merge".
      }
    },
    [shipDefaultStorageKey],
  );

  const { flatItems, stickyHeaderIndices } = useMemo(() => {
    const items: DiffFlatItem[] = [];
    const stickyIndices: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isExpanded = expandedPaths.has(file.path);
      items.push({ type: "header", file, fileIndex: i, isExpanded });
      if (isExpanded) {
        stickyIndices.push(items.length - 1);
      }
      if (isExpanded) {
        items.push({ type: "body", file, fileIndex: i });
      }
    }
    return { flatItems: items, stickyHeaderIndices: stickyIndices };
  }, [expandedPaths, files]);

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    defaultHeaderHeightRef.current = height;
  }, []);

  const handleBodyHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height < 0) {
      return;
    }
    bodyHeightByPathRef.current[path] = height;
  }, []);

  const handleDiffListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (hoveredLineKey !== null) {
        setHoveredLineKey(null);
      }
      if (armedLineKey !== null) {
        setArmedLineKey(null);
      }
      diffListScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
      scrollbar.onScroll(event);
    },
    [armedLineKey, hoveredLineKey, scrollbar.onScroll],
  );

  const handleDiffListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      diffListViewportHeightRef.current = height;
      scrollbar.onLayout(event);
    },
    [scrollbar.onLayout],
  );

  const computeHeaderOffset = useCallback(
    (path: string): number => {
      const defaultHeaderHeight = defaultHeaderHeightRef.current;
      let offset = 0;
      for (const file of files) {
        if (file.path === path) {
          break;
        }
        offset += headerHeightByPathRef.current[file.path] ?? defaultHeaderHeight;
        if (expandedPaths.has(file.path)) {
          offset += bodyHeightByPathRef.current[file.path] ?? 0;
        }
      }
      return Math.max(0, offset);
    },
    [expandedPaths, files],
  );

  const handleToggleExpanded = useCallback(
    (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const isCurrentlyExpanded = expandedPaths.has(path);
      const nextExpanded = !isCurrentlyExpanded;
      const targetOffset = isCurrentlyExpanded ? computeHeaderOffset(path) : null;
      const headerHeight = headerHeightByPathRef.current[path] ?? defaultHeaderHeightRef.current;
      const shouldAnchor =
        isCurrentlyExpanded &&
        targetOffset !== null &&
        shouldAnchorHeaderBeforeCollapse({
          headerOffset: targetOffset,
          headerHeight,
          viewportOffset: diffListScrollOffsetRef.current,
          viewportHeight: diffListViewportHeightRef.current,
        });

      // Anchor to the clicked header before collapsing so visual context is preserved.
      if (shouldAnchor && targetOffset !== null) {
        diffListRef.current?.scrollToOffset({
          offset: targetOffset,
          animated: false,
        });
      }

      const nextPaths = nextExpanded
        ? [...expandedPaths, path]
        : Array.from(expandedPaths).filter((expandedPath) => expandedPath !== path);
      setDiffExpandedPathsForWorkspace(workspaceStateKey, nextPaths);
    },
    [computeHeaderOffset, expandedPaths, setDiffExpandedPathsForWorkspace, workspaceStateKey],
  );

  const allExpanded = useMemo(() => {
    if (files.length === 0) return false;
    return files.every((file) => expandedPaths.has(file.path));
  }, [expandedPaths, files]);

  const handleToggleExpandAll = useCallback(() => {
    if (!workspaceStateKey) {
      return;
    }
    if (allExpanded) {
      setDiffExpandedPathsForWorkspace(workspaceStateKey, []);
    } else {
      setDiffExpandedPathsForWorkspace(
        workspaceStateKey,
        files.map((file) => file.path),
      );
    }
  }, [allExpanded, files, setDiffExpandedPathsForWorkspace, workspaceStateKey]);

  // Reset manual refresh flag when fetch completes
  useEffect(() => {
    if (!(isDiffFetching || isStatusFetching) && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isDiffFetching, isStatusFetching, isManualRefresh]);

  // Clear diff mode override when auto mode changes (e.g., after commit)
  useEffect(() => {
    setDiffModeOverride(null);
  }, [autoDiffMode]);

  const commitStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "commit" }),
  );
  const pushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "push" }),
  );
  const prCreateStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "create-pr" }),
  );
  const mergeStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-branch" }),
  );
  const mergeFromBaseStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-from-base" }),
  );
  const archiveStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "archive-worktree" }),
  );

  const runCommit = useCheckoutGitActionsStore((state) => state.commit);
  const runPush = useCheckoutGitActionsStore((state) => state.push);
  const runCreatePr = useCheckoutGitActionsStore((state) => state.createPr);
  const runMergeBranch = useCheckoutGitActionsStore((state) => state.mergeBranch);
  const runMergeFromBase = useCheckoutGitActionsStore((state) => state.mergeFromBase);
  const runArchiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);

  const handleCommit = useCallback(() => {
    setActionError(null);
    void runCommit({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to commit";
      setActionError(message);
    });
  }, [runCommit, serverId, cwd]);

  const handlePush = useCallback(() => {
    setActionError(null);
    void runPush({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to push";
      setActionError(message);
    });
  }, [runPush, serverId, cwd]);

  const handleCreatePr = useCallback(() => {
    void persistShipDefault("pr");
    setActionError(null);
    void runCreatePr({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to create PR";
      setActionError(message);
    });
  }, [persistShipDefault, runCreatePr, serverId, cwd]);

  const handleMergeBranch = useCallback(() => {
    if (!baseRef) {
      setActionError("Base ref unavailable");
      return;
    }
    void persistShipDefault("merge");
    setActionError(null);
    void runMergeBranch({ serverId, cwd, baseRef })
      .then(() => {
        setPostShipArchiveSuggested(true);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Failed to merge";
        setActionError(message);
      });
  }, [baseRef, persistShipDefault, runMergeBranch, serverId, cwd]);

  const handleMergeFromBase = useCallback(() => {
    if (!baseRef) {
      setActionError("Base ref unavailable");
      return;
    }
    setActionError(null);
    void runMergeFromBase({ serverId, cwd, baseRef }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to merge from base";
      setActionError(message);
    });
  }, [baseRef, runMergeFromBase, serverId, cwd]);

  const handleArchiveWorktree = useCallback(() => {
    const worktreePath = status?.cwd;
    if (!worktreePath) {
      setActionError("Worktree path unavailable");
      return;
    }
    setActionError(null);
    const targetWorkingDir = resolveNewAgentWorkingDir(cwd, status ?? null);
    void runArchiveWorktree({ serverId, cwd, worktreePath })
      .then(() => {
        router.replace(buildNewAgentRoute(serverId, targetWorkingDir) as any);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Failed to archive worktree";
        setActionError(message);
      });
  }, [runArchiveWorktree, router, serverId, cwd, status]);

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffFlatItem }) => {
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            isExpanded={item.isExpanded}
            onToggle={handleToggleExpanded}
            onAddFileReference={handleAddFileReference}
            onClearArmedLine={() => {
              setHoveredLineKey(null);
              setArmedLineKey(null);
            }}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-file-${item.fileIndex}`}
          />
        );
      }
      return (
        <DiffFileBody
          file={item.file}
          layout={effectiveLayout}
          wrapLines={wrapLines}
          hunkActionMode={hunkActionMode}
          hoveredLineKey={hoveredLineKey}
          onHoverLine={setHoveredLineKey}
          onLeaveLine={() => setHoveredLineKey(null)}
          armedLineKey={armedLineKey}
          onArmLine={setArmedLineKey}
          onClearArmedLine={() => {
            setHoveredLineKey(null);
            setArmedLineKey(null);
          }}
          onAddHunkReference={handleAddHunkReference}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-file-${item.fileIndex}-body`}
        />
      );
    },
    [
      armedLineKey,
      effectiveLayout,
      handleAddFileReference,
      handleAddHunkReference,
      handleBodyHeightChange,
      handleHeaderHeightChange,
      handleToggleExpanded,
      hunkActionMode,
      hoveredLineKey,
      wrapLines,
    ],
  );

  const flatKeyExtractor = useCallback(
    (item: DiffFlatItem) => `${item.type}-${item.file.path}`,
    [],
  );

  const hasChanges = files.length > 0;
  const diffErrorMessage =
    diffPayloadError?.message ??
    (isDiffError && diffError instanceof Error ? diffError.message : null);
  const prErrorMessage = githubFeaturesEnabled ? (prPayloadError?.message ?? null) : null;
  const branchLabel =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD"
      ? gitStatus.currentBranch
      : notGit
        ? "Not a git repository"
        : "Unknown";
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  const aheadCount = gitStatus?.aheadBehind?.ahead ?? 0;
  const aheadOfOrigin = gitStatus?.aheadOfOrigin ?? 0;
  const behindOfOrigin = gitStatus?.behindOfOrigin ?? 0;
  const baseRefLabel = useMemo(() => {
    if (!baseRef) return "base";
    const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
    return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
  }, [baseRef]);
  const committedDiffDescription = useMemo(() => {
    if (!branchLabel || !baseRefLabel) {
      return undefined;
    }
    return branchLabel === baseRefLabel ? undefined : `${branchLabel} -> ${baseRefLabel}`;
  }, [baseRefLabel, branchLabel]);
  const hasPullRequest = Boolean(prStatus?.url);
  const hasRemote = gitStatus?.hasRemote ?? false;
  const isPaseoOwnedWorktree = gitStatus?.isPaseoOwnedWorktree ?? false;
  const isMergedPullRequest = Boolean(prStatus?.isMerged);
  const currentBranch = gitStatus?.currentBranch;
  const isOnBaseBranch = currentBranch === baseRefLabel;
  const shouldPromoteArchive =
    isPaseoOwnedWorktree &&
    !hasUncommittedChanges &&
    (postShipArchiveSuggested || isMergedPullRequest);

  const commitDisabled = actionsDisabled || commitStatus === "pending";
  const prDisabled = actionsDisabled || prCreateStatus === "pending";
  const mergeDisabled = actionsDisabled || mergeStatus === "pending";
  const mergeFromBaseDisabled = actionsDisabled || mergeFromBaseStatus === "pending";
  const pushDisabled = actionsDisabled || pushStatus === "pending";
  const archiveDisabled = actionsDisabled || archiveStatus === "pending";

  let bodyContent: ReactElement;

  if (isStatusLoading) {
    bodyContent = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
        <Text style={styles.loadingText}>Checking repository...</Text>
      </View>
    );
  } else if (statusErrorMessage) {
    bodyContent = (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{statusErrorMessage}</Text>
      </View>
    );
  } else if (notGit) {
    bodyContent = (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={styles.emptyText}>Not a git repository</Text>
      </View>
    );
  } else if (isDiffLoading) {
    bodyContent = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
      </View>
    );
  } else if (diffErrorMessage) {
    bodyContent = (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{diffErrorMessage}</Text>
      </View>
    );
  } else if (!hasChanges) {
    bodyContent = (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {changesPreferences.hideWhitespace
            ? "No visible changes after hiding whitespace"
            : diffMode === "uncommitted"
              ? "No uncommitted changes"
              : `No changes vs ${baseRefLabel}`}
        </Text>
      </View>
    );
  } else {
    bodyContent = (
      <FlatList
        ref={diffListRef}
        data={flatItems}
        renderItem={renderFlatItem}
        keyExtractor={flatKeyExtractor}
        stickyHeaderIndices={stickyHeaderIndices}
        extraData={{ armedLineKey, expandedPathsArray, effectiveLayout, hoveredLineKey, wrapLines }}
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        testID="git-diff-scroll"
        onLayout={handleDiffListLayout}
        onScroll={handleDiffListScroll}
        onContentSizeChange={scrollbar.onContentSizeChange}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={!showDesktopWebScrollbar}
        onRefresh={handleRefresh}
        refreshing={isManualRefresh && isDiffFetching}
        // Mixed-height rows (header + potentially very large body) are prone to clipping artifacts.
        // Keep a larger render window and disable clipping to avoid bodies disappearing mid-scroll.
        removeClippedSubviews={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={10}
      />
    );
  }

  useEffect(() => {
    setPostShipArchiveSuggested(false);
  }, [cwd]);

  // ==========================================================================
  // Git Actions (Data-Oriented)
  // ==========================================================================
  // All possible actions are computed as data, then partitioned into:
  // - primary: The main CTA button
  // - secondary: Dropdown next to primary button
  // - menu: Kebab overflow menu
  // ==========================================================================

  const gitActions: GitActions = useMemo(() => {
    return buildGitActions({
      isGit,
      githubFeaturesEnabled,
      hasPullRequest,
      pullRequestUrl: prStatus?.url ?? null,
      hasRemote,
      isPaseoOwnedWorktree,
      isOnBaseBranch,
      hasUncommittedChanges,
      baseRefAvailable: Boolean(baseRef),
      baseRefLabel,
      aheadCount,
      aheadOfOrigin,
      behindOfOrigin,
      shouldPromoteArchive,
      shipDefault,
      runtime: {
        commit: {
          disabled: commitDisabled,
          status: commitStatus,
          icon: <GitCommitHorizontal size={16} color={theme.colors.foregroundMuted} />,
          handler: handleCommit,
        },
        push: {
          disabled: pushDisabled,
          status: pushStatus,
          icon: <Upload size={16} color={theme.colors.foregroundMuted} />,
          handler: handlePush,
        },
        pr: {
          disabled: prDisabled,
          status: hasPullRequest ? "idle" : prCreateStatus,
          icon: <GitHubIcon size={16} color={theme.colors.foregroundMuted} />,
          handler: () => {
            if (prStatus?.url) {
              openURLInNewTab(prStatus.url);
              return;
            }
            handleCreatePr();
          },
        },
        "merge-branch": {
          disabled: mergeDisabled,
          status: mergeStatus,
          icon: <GitMerge size={16} color={theme.colors.foregroundMuted} />,
          handler: handleMergeBranch,
        },
        "merge-from-base": {
          disabled: mergeFromBaseDisabled,
          status: mergeFromBaseStatus,
          icon: <RefreshCcw size={16} color={theme.colors.foregroundMuted} />,
          handler: handleMergeFromBase,
        },
        "archive-worktree": {
          disabled: archiveDisabled,
          status: archiveStatus,
          icon: <Archive size={16} color={theme.colors.foregroundMuted} />,
          handler: handleArchiveWorktree,
        },
      },
    });
  }, [
    isGit,
    hasRemote,
    hasPullRequest,
    prStatus?.url,
    aheadCount,
    isPaseoOwnedWorktree,
    isOnBaseBranch,
    githubFeaturesEnabled,
    hasUncommittedChanges,
    aheadOfOrigin,
    behindOfOrigin,
    shipDefault,
    baseRefLabel,
    shouldPromoteArchive,
    commitDisabled,
    pushDisabled,
    prDisabled,
    mergeDisabled,
    mergeFromBaseDisabled,
    archiveDisabled,
    commitStatus,
    pushStatus,
    prCreateStatus,
    mergeStatus,
    mergeFromBaseStatus,
    archiveStatus,
    handleCommit,
    handlePush,
    handleCreatePr,
    handleMergeBranch,
    handleMergeFromBase,
    handleArchiveWorktree,
    theme.colors.foregroundMuted,
  ]);

  // Helper to get display label based on status

  return (
    <View style={styles.container}>
      {!hideHeaderRow ? (
        <View style={styles.header} testID="changes-header">
          <View style={styles.headerLeft}>
            <GitBranch size={16} color={theme.colors.foregroundMuted} />
            <Text style={styles.branchLabel} testID="changes-branch" numberOfLines={1}>
              {branchLabel}
            </Text>
          </View>
          {isGit ? <GitActionsSplitButton gitActions={gitActions} /> : null}
        </View>
      ) : null}

      {isGit ? (
        <View style={styles.diffStatusContainer}>
          <View style={styles.diffStatusInner}>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ hovered, pressed, open }) => [
                  styles.diffModeTrigger,
                  hovered && styles.diffModeTriggerHovered,
                  (pressed || open) && styles.diffModeTriggerPressed,
                ]}
                testID="changes-diff-status"
                accessibilityRole="button"
                accessibilityLabel="Diff mode"
              >
                <Text style={styles.diffStatusText} numberOfLines={1}>
                  {diffMode === "uncommitted" ? "Uncommitted" : "Committed"}
                </Text>
                <ChevronDown size={12} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" width={260} testID="changes-diff-status-menu">
                <DropdownMenuItem
                  testID="changes-diff-mode-uncommitted"
                  selected={diffMode === "uncommitted"}
                  onSelect={() => setDiffModeOverride("uncommitted")}
                >
                  Uncommitted
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  testID="changes-diff-mode-committed"
                  selected={diffMode === "base"}
                  description={committedDiffDescription}
                  onSelect={() => setDiffModeOverride("base")}
                >
                  Committed
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <View style={styles.diffStatusButtons}>
              {canUseSplitLayout ? (
                <View style={styles.toggleButtonGroup}>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Unified diff"
                        testID="changes-layout-unified"
                        onPress={() => handleLayoutChange("unified")}
                        style={({ hovered, pressed }) => [
                          styles.toggleButton,
                          styles.toggleButtonGroupStart,
                          changesPreferences.layout === "unified" && styles.toggleButtonSelected,
                          (hovered || pressed) && styles.diffStatusRowHovered,
                        ]}
                      >
                        <AlignJustify
                          size={14}
                          color={
                            changesPreferences.layout === "unified"
                              ? theme.colors.foreground
                              : theme.colors.foregroundMuted
                          }
                        />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <Text style={styles.tooltipText}>Unified diff</Text>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Side-by-side diff"
                        testID="changes-layout-split"
                        onPress={() => handleLayoutChange("split")}
                        style={({ hovered, pressed }) => [
                          styles.toggleButton,
                          styles.toggleButtonGroupEnd,
                          changesPreferences.layout === "split" && styles.toggleButtonSelected,
                          (hovered || pressed) && styles.diffStatusRowHovered,
                        ]}
                      >
                        <Columns2
                          size={14}
                          color={
                            changesPreferences.layout === "split"
                              ? theme.colors.foreground
                              : theme.colors.foregroundMuted
                          }
                        />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <Text style={styles.tooltipText}>Side-by-side diff</Text>
                    </TooltipContent>
                  </Tooltip>
                </View>
              ) : null}
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Hide whitespace"
                    testID="changes-toggle-whitespace"
                    style={({ hovered, pressed }) => [
                      styles.expandAllButton,
                      changesPreferences.hideWhitespace && styles.toggleButtonSelected,
                      (hovered || pressed) && styles.diffStatusRowHovered,
                    ]}
                    onPress={handleToggleHideWhitespace}
                  >
                    <Pilcrow
                      size={isMobile ? 18 : 14}
                      color={
                        changesPreferences.hideWhitespace
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <Text style={styles.tooltipText}>Hide whitespace</Text>
                </TooltipContent>
              </Tooltip>
              {files.length > 0 ? (
                <View style={styles.diffStatusButtons}>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        style={({ hovered, pressed }) => [
                          styles.expandAllButton,
                          wrapLines && styles.toggleButtonSelected,
                          (hovered || pressed) && styles.diffStatusRowHovered,
                        ]}
                        onPress={handleToggleWrapLines}
                      >
                        <WrapText
                          size={isMobile ? 18 : 14}
                          color={wrapLines ? theme.colors.foreground : theme.colors.foregroundMuted}
                        />
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <Text style={styles.tooltipText}>
                        {wrapLines ? "Scroll long lines" : "Wrap long lines"}
                      </Text>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        style={({ hovered, pressed }) => [
                          styles.expandAllButton,
                          (hovered || pressed) && styles.diffStatusRowHovered,
                        ]}
                        onPress={handleToggleExpandAll}
                      >
                        {allExpanded ? (
                          <ListChevronsDownUp
                            size={isMobile ? 18 : 14}
                            color={theme.colors.foregroundMuted}
                          />
                        ) : (
                          <ListChevronsUpDown
                            size={isMobile ? 18 : 14}
                            color={theme.colors.foregroundMuted}
                          />
                        )}
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <Text style={styles.tooltipText}>
                        {allExpanded ? "Collapse all files" : "Expand all files"}
                      </Text>
                    </TooltipContent>
                  </Tooltip>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

      {actionError ? <Text style={styles.actionErrorText}>{actionError}</Text> : null}
      {prErrorMessage ? <Text style={styles.actionErrorText}>{prErrorMessage}</Text> : null}

      <View style={styles.diffContainer}>
        {bodyContent}
        {hasChanges ? scrollbar.overlay : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  branchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  diffStatusContainer: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffStatusInner: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
  },
  diffModeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    // Align text with header branch icon (at spacing[3] from edge, minus our horizontal padding)
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: {
      xs: 28,
      sm: 28,
      md: 24,
    },
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  diffModeTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffModeTriggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusText: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.25,
    color: theme.colors.foregroundMuted,
  },
  diffStatusIconHidden: {
    opacity: 0,
  },
  diffStatusButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  toggleButtonGroup: {
    flexDirection: "row",
    alignItems: "center",
  },
  toggleButton: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    height: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    paddingHorizontal: {
      xs: theme.spacing[2],
      sm: theme.spacing[2],
      md: theme.spacing[1],
    },
  },
  toggleButtonGroupStart: {
    borderTopLeftRadius: theme.borderRadius.base,
    borderBottomLeftRadius: theme.borderRadius.base,
  },
  toggleButtonGroupEnd: {
    borderTopRightRadius: theme.borderRadius.base,
    borderBottomRightRadius: theme.borderRadius.base,
  },
  toggleButtonSelected: {
    backgroundColor: theme.colors.surface2,
  },
  expandAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    minWidth: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    height: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    paddingHorizontal: {
      xs: theme.spacing[2],
      sm: theme.spacing[2],
      md: theme.spacing[1],
    },
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  actionErrorText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: theme.spacing[8],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
  },
  fileSection: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileSectionHeaderContainer: {
    overflow: "hidden",
  },
  fileSectionHeaderExpanded: {
    backgroundColor: theme.colors.surface1,
  },
  fileSectionBodyContainer: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  fileSectionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    zIndex: 2,
    elevation: 2,
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderPressed: {
    opacity: 0.7,
  },
  fileHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  newBadge: {
    backgroundColor: "rgba(46, 160, 67, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  newBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  deletedBadge: {
    backgroundColor: "rgba(248, 81, 73, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  deletedBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
  },
  additions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  diffContentRow: {
    flexDirection: "row",
    alignItems: "stretch",
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
  gutterColumn: {
    backgroundColor: theme.colors.surface1,
  },
  gutterCell: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    justifyContent: "flex-start",
  },
  textLineContainer: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingLeft: theme.spacing[2],
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  splitColumnScroll: {
    flex: 1,
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
    backgroundColor: "rgba(46, 160, 67, 0.15)", // GitHub green
  },
  addLineText: {
    color: theme.colors.foreground,
  },
  removeLineContainer: {
    backgroundColor: "rgba(248, 81, 73, 0.1)", // GitHub red
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
