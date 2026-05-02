import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  memo,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouter } from "expo-router";
import { DiffStat } from "@/components/diff-stat";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type PressableStateCallbackType,
  type FlatListProps,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  AlignJustify,
  Archive,
  ArrowDownUp,
  ChevronDown,
  Columns2,
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Pilcrow,
  RefreshCcw,
  Upload,
  WrapText,
} from "lucide-react-native";
import {
  useCheckoutGitActionsStore,
  type CheckoutGitActionStatus,
} from "@/stores/checkout-git-actions-store";
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
  buildUnifiedDiffLines,
  type ReviewableDiffTarget,
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
import { usePanelStore } from "@/stores/panel-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { useToast } from "@/contexts/toast-context";
import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
} from "@/utils/diff-rendering";
import { isWeb, isNative } from "@/constants/platform";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftScopeKey,
  buildReviewDraftKey,
  useActiveReviewDraftMode,
  useReviewAttachmentSnapshot,
  useSetActiveReviewDraftMode,
  type ReviewDraftComment,
  type ReviewDraftMode,
  getInlineReviewThreadState,
  getSplitInlineReviewThreadState,
  InlineReviewGutterCell,
  InlineReviewThread,
  isInlineReviewEditorForTarget,
  useInlineReviewController,
  type InlineReviewActions,
} from "@/review";

export type { GitActionId, GitAction, GitActions } from "@/components/git-actions-policy";

function openURLInNewTab(url: string): void {
  void openExternalUrl(url);
}

function fileHeaderPressableStyle({ pressed }: PressableStateCallbackType) {
  return [styles.fileHeader, pressed && styles.fileHeaderPressed];
}

function diffModeTriggerStyle({
  hovered,
  pressed,
  open,
}: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) {
  return [
    styles.diffModeTrigger,
    Boolean(hovered) && styles.diffModeTriggerHovered,
    (pressed || Boolean(open)) && styles.diffModeTriggerPressed,
  ];
}

function expandAllButtonStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.expandAllButton, (Boolean(hovered) || pressed) && styles.diffStatusRowHovered];
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
  if (isNative) {
    return undefined;
  }
  return wrapLines
    ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
    : { whiteSpace: "pre", overflowWrap: "normal" };
}

function HighlightedToken({
  text,
  color,
  lineHeight,
}: {
  text: string;
  color: string;
  lineHeight: number;
}) {
  const tokenStyle = useMemo(() => ({ color, lineHeight }), [color, lineHeight]);
  return <Text style={tokenStyle}>{text}</Text>;
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

  const containerStyle = useMemo(
    () => [styles.diffLineText, { lineHeight, ...getWrappedTextStyle(wrapLines) }],
    [lineHeight, wrapLines],
  );

  const keyedTokens = useMemo(
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );

  return (
    <Text style={containerStyle}>
      {keyedTokens.map(({ key, token }) => (
        <HighlightedToken
          key={key}
          text={token.text}
          color={getTokenColor(token.style)}
          lineHeight={lineHeight}
        />
      ))}
    </Text>
  );
}

interface DiffFileSectionProps {
  file: ParsedDiffFile;
  isExpanded: boolean;
  onToggle: (path: string) => void;
  onHeaderHeightChange?: (path: string, height: number) => void;
  testID?: string;
}

const EMPTY_COMMENTS: readonly ReviewDraftComment[] = [];

function noopStartComment(): void {}

const DIFF_LINE_HOVER_STYLE = isWeb ? ({ cursor: "auto" } as const) : null;

function LongPressableLine({
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
  style,
  children,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions: InlineReviewActions | undefined;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const onStartComment = reviewActions?.onStartComment;
  const handlePress = useCallback(() => {
    if (reviewTarget && onStartComment) {
      onStartComment(reviewTarget);
    }
  }, [reviewTarget, onStartComment]);

  const handleHoverIn = useCallback(() => {
    onHoverChange?.(true);
    if (hoverTargetKey) {
      onHoverTargetChange?.(hoverTargetKey);
    }
  }, [hoverTargetKey, onHoverChange, onHoverTargetChange]);
  const handleHoverOut = useCallback(() => {
    onHoverChange?.(false);
    if (hoverTargetKey) {
      onHoverTargetChange?.(null);
    }
  }, [hoverTargetKey, onHoverChange, onHoverTargetChange]);
  const hoverStyle = useMemo(() => [style, DIFF_LINE_HOVER_STYLE], [style]);

  if (isWeb && (onHoverChange || onHoverTargetChange)) {
    return (
      <Pressable onHoverIn={handleHoverIn} onHoverOut={handleHoverOut} style={hoverStyle}>
        {children}
      </Pressable>
    );
  }

  if (!isNative || !reviewTarget || !onStartComment) {
    return <View style={style}>{children}</View>;
  }
  return (
    <Pressable onPress={handlePress} style={style}>
      {children}
    </Pressable>
  );
}

function lineTypeBackground(type: DiffLine["type"] | undefined | null) {
  if (!type) return styles.emptySplitCell;
  if (type === "add") return styles.addLineContainer;
  if (type === "remove") return styles.removeLineContainer;
  if (type === "header") return styles.headerLineContainer;
  return styles.contextLineContainer;
}

function DiffGutterCell({
  lineNumber,
  type,
  gutterWidth,
  reviewTarget,
  reviewActions,
  isLineHovered,
  style,
}: {
  lineNumber: number | null;
  type: DiffLine["type"] | undefined | null;
  gutterWidth: number;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  isLineHovered?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const containerStyle = useMemo(
    () => [styles.gutterCell, lineTypeBackground(type), { width: gutterWidth }, style],
    [type, gutterWidth, style],
  );
  const textStyle = useMemo(
    () => [
      styles.lineNumberText,
      type === "add" && styles.addLineNumberText,
      type === "remove" && styles.removeLineNumberText,
    ],
    [type],
  );
  const comments = useMemo(
    () =>
      reviewTarget
        ? (reviewActions?.commentsByTarget.get(reviewTarget.key) ?? EMPTY_COMMENTS)
        : EMPTY_COMMENTS,
    [reviewTarget, reviewActions?.commentsByTarget],
  );
  const isEditorOpen = isInlineReviewEditorForTarget(reviewActions?.editor ?? null, reviewTarget);
  const onStartComment = reviewActions?.onStartComment ?? noopStartComment;

  return (
    <InlineReviewGutterCell
      reviewTarget={reviewTarget}
      comments={comments}
      isEditorOpen={isEditorOpen}
      isLineHovered={isLineHovered}
      onStartComment={onStartComment}
      style={containerStyle}
    >
      <Text numberOfLines={1} style={textStyle}>
        {formatDiffGutterText(lineNumber)}
      </Text>
    </InlineReviewGutterCell>
  );
}

function DiffTextLine({
  line,
  wrapLines,
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
}: {
  line: DiffLine;
  wrapLines: boolean;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
}) {
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line.type)],
    [line.type],
  );
  const textStyle = useMemo(
    () => [
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={onHoverChange}
      hoverTargetKey={hoverTargetKey}
      onHoverTargetChange={onHoverTargetChange}
      style={containerStyle}
    >
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText tokens={visibleTokens} wrapLines={wrapLines} />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function SplitTextLine({
  line,
  wrapLines,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
}: {
  line: SplitDiffDisplayLine | null;
  wrapLines: boolean;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
}) {
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line?.type)],
    [line?.type],
  );
  const textStyle = useMemo(
    () => [
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={line?.reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={onHoverChange}
      hoverTargetKey={hoverTargetKey}
      onHoverTargetChange={onHoverTargetChange}
      style={containerStyle}
    >
      {visibleTokens ? (
        <HighlightedText tokens={visibleTokens} wrapLines={wrapLines} />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line?.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function DiffLineView({
  line,
  lineNumber,
  gutterWidth,
  wrapLines,
  reviewTarget,
  reviewActions,
}: {
  line: DiffLine;
  lineNumber: number | null;
  gutterWidth: number;
  wrapLines: boolean;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line.type)],
    [line.type],
  );
  const textStyle = useMemo(
    () => [
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={setIsLineHovered}
      style={containerStyle}
    >
      <DiffGutterCell
        lineNumber={lineNumber}
        type={line.type}
        gutterWidth={gutterWidth}
        reviewTarget={reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText tokens={visibleTokens} wrapLines={wrapLines} />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function SplitDiffLine({
  line,
  gutterWidth,
  wrapLines,
  reviewActions,
}: {
  line: SplitDiffDisplayLine | null;
  gutterWidth: number;
  wrapLines: boolean;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line?.type)],
    [line?.type],
  );
  const textStyle = useMemo(
    () => [
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={line?.reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={setIsLineHovered}
      style={containerStyle}
    >
      <DiffGutterCell
        lineNumber={line?.lineNumber ?? null}
        type={line?.type}
        gutterWidth={gutterWidth}
        reviewTarget={line?.reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {visibleTokens ? (
        <HighlightedText tokens={visibleTokens} wrapLines={wrapLines} />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line?.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function InlineReviewThreadContent({
  reviewTarget,
  reviewActions,
  reservedHeight,
  viewportWidth,
  pinToViewport,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  reservedHeight?: number;
  viewportWidth?: number;
  pinToViewport?: boolean;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const placeholderStyle = useMemo<ViewStyle>(() => ({ minHeight: height }), [height]);
  if (height === 0) {
    return null;
  }
  if (!reviewTarget || !reviewActions || !threadState) {
    return <View style={placeholderStyle} />;
  }

  return (
    <InlineReviewThread
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      height={height}
      viewportWidth={viewportWidth}
      pinToViewport={pinToViewport}
      testID={`review-thread-${reviewTarget.key}`}
    />
  );
}

function InlineReviewGutterSpacer({
  reviewTarget,
  reviewActions,
  gutterWidth,
  reservedHeight,
  style,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  gutterWidth: number;
  reservedHeight?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const spacerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.inlineReviewGutterSpacer, { width: gutterWidth, minHeight: height }, style],
    [gutterWidth, height, style],
  );
  if (height === 0) {
    return null;
  }

  return <View style={spacerStyle} />;
}

function InlineReviewRow({
  reviewTarget,
  reviewActions,
  gutterWidth,
  reservedHeight,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  gutterWidth: number;
  reservedHeight?: number;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const gutterSpacerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.inlineReviewGutterSpacer, { width: gutterWidth }],
    [gutterWidth],
  );
  const placeholderStyle = useMemo<ViewStyle>(() => ({ minHeight: height }), [height]);
  if (height === 0) {
    return null;
  }

  return (
    <View style={styles.inlineReviewRow}>
      <View style={gutterSpacerStyle} />
      {reviewTarget && reviewActions && threadState ? (
        <InlineReviewThread
          reviewTarget={reviewTarget}
          reviewActions={reviewActions}
          height={height}
          testID={`review-thread-${reviewTarget.key}`}
        />
      ) : (
        <View style={placeholderStyle} />
      )}
    </View>
  );
}

function SplitDiffColumn({
  rows,
  side,
  gutterWidth,
  wrapLines,
  reviewActions,
  showDivider = false,
}: {
  rows: SplitDiffRow[];
  side: "left" | "right";
  gutterWidth: number;
  wrapLines: boolean;
  reviewActions?: InlineReviewActions;
  showDivider?: boolean;
}) {
  const [scrollWidth, setScrollWidth] = useState(0);
  const [hoveredReviewTargetKey, setHoveredReviewTargetKey] = useState<string | null>(null);

  const wrapCellStyle = useMemo(
    () => [styles.splitCell, showDivider && styles.splitCellWithDivider],
    [showDivider],
  );
  const rowCellStyle = useMemo(
    () => [styles.splitCell, showDivider && styles.splitCellWithDivider, styles.splitCellRow],
    [showDivider],
  );
  const linesContainerRowStyle = useMemo(
    () => [styles.linesContainer, scrollWidth > 0 && { minWidth: scrollWidth }],
    [scrollWidth],
  );

  const keyedRows = useMemo(() => rows.map((row, i) => ({ key: `row-${i}`, row })), [rows]);

  if (wrapLines) {
    return (
      <View style={wrapCellStyle}>
        <View style={styles.linesContainer}>
          {keyedRows.map(({ key, row }) => {
            if (row.kind === "header") {
              return (
                <View key={key} style={styles.splitHeaderRow}>
                  <Text style={HEADER_LINE_TEXT_STYLE}>{row.content}</Text>
                </View>
              );
            }
            const line = side === "left" ? row.left : row.right;
            const reviewRowState = getSplitInlineReviewThreadState({
              left: row.left?.reviewTarget,
              right: row.right?.reviewTarget,
              reviewActions,
            });
            return (
              <View key={key}>
                <SplitDiffLine
                  line={line}
                  gutterWidth={gutterWidth}
                  wrapLines={wrapLines}
                  reviewActions={reviewActions}
                />
                <InlineReviewRow
                  reviewTarget={line?.reviewTarget}
                  reviewActions={reviewActions}
                  gutterWidth={gutterWidth}
                  reservedHeight={reviewRowState?.height}
                />
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={rowCellStyle}>
      <View style={styles.gutterColumn}>
        {keyedRows.map(({ key, row }) => {
          if (row.kind === "header") {
            return (
              <DiffGutterCell key={key} lineNumber={null} type="header" gutterWidth={gutterWidth} />
            );
          }
          const line = side === "left" ? row.left : row.right;
          const reviewTargetKey = line?.reviewTarget?.key ?? null;
          const reviewRowState = getSplitInlineReviewThreadState({
            left: row.left?.reviewTarget,
            right: row.right?.reviewTarget,
            reviewActions,
          });
          return (
            <View key={key}>
              <DiffGutterCell
                lineNumber={line?.lineNumber ?? null}
                type={line?.type}
                gutterWidth={gutterWidth}
                reviewTarget={line?.reviewTarget}
                reviewActions={reviewActions}
                isLineHovered={
                  reviewTargetKey !== null && hoveredReviewTargetKey === reviewTargetKey
                }
              />
              <InlineReviewGutterSpacer
                reviewTarget={line?.reviewTarget}
                reviewActions={reviewActions}
                gutterWidth={gutterWidth}
                reservedHeight={reviewRowState?.height}
              />
            </View>
          );
        })}
      </View>
      <DiffScroll
        scrollViewWidth={scrollWidth}
        onScrollViewWidthChange={setScrollWidth}
        style={styles.splitColumnScroll}
        contentContainerStyle={styles.diffContentInner}
      >
        <View style={linesContainerRowStyle}>
          {keyedRows.map(({ key, row }) => {
            if (row.kind === "header") {
              return (
                <View key={key} style={styles.splitHeaderRow}>
                  <Text style={HEADER_LINE_TEXT_STYLE}>{row.content}</Text>
                </View>
              );
            }
            const line = side === "left" ? row.left : row.right;
            const reviewTargetKey = line?.reviewTarget?.key ?? null;
            const reviewRowState = getSplitInlineReviewThreadState({
              left: row.left?.reviewTarget,
              right: row.right?.reviewTarget,
              reviewActions,
            });
            return (
              <View key={key}>
                <SplitTextLine
                  line={line}
                  wrapLines={false}
                  reviewActions={reviewActions}
                  hoverTargetKey={reviewTargetKey}
                  onHoverTargetChange={setHoveredReviewTargetKey}
                />
                <InlineReviewThreadContent
                  reviewTarget={line?.reviewTarget}
                  reviewActions={reviewActions}
                  reservedHeight={reviewRowState?.height}
                  viewportWidth={scrollWidth}
                  pinToViewport
                />
              </View>
            );
          })}
        </View>
      </DiffScroll>
    </View>
  );
}

const DiffFileHeader = memo(function DiffFileHeader({
  file,
  isExpanded,
  onToggle,
  onHeaderHeightChange,
  testID,
}: DiffFileSectionProps) {
  const layoutYRef = useRef<number | null>(null);
  const pressHandledRef = useRef(false);
  const pressInRef = useRef<{ ts: number; pageX: number; pageY: number } | null>(null);

  const toggleExpanded = useCallback(() => {
    pressHandledRef.current = true;
    onToggle(file.path);
  }, [file.path, onToggle]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      layoutYRef.current = event.nativeEvent.layout.y;
      onHeaderHeightChange?.(file.path, event.nativeEvent.layout.height);
    },
    [file.path, onHeaderHeightChange],
  );

  const handlePressIn = useCallback((event: { nativeEvent: { pageX: number; pageY: number } }) => {
    pressHandledRef.current = false;
    pressInRef.current = {
      ts: Date.now(),
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handlePressOut = useCallback(
    (event: { nativeEvent: { pageX: number; pageY: number } }) => {
      if (isNative && !pressHandledRef.current && layoutYRef.current === 0 && pressInRef.current) {
        const durationMs = Date.now() - pressInRef.current.ts;
        const dx = event.nativeEvent.pageX - pressInRef.current.pageX;
        const dy = event.nativeEvent.pageY - pressInRef.current.pageY;
        const distance = Math.hypot(dx, dy);
        if (durationMs <= 500 && distance <= 12) {
          toggleExpanded();
        }
      }
    },
    [toggleExpanded],
  );

  const containerStyle = useMemo(
    () => [styles.fileSectionHeaderContainer, isExpanded && styles.fileSectionHeaderExpanded],
    [isExpanded],
  );

  return (
    <View style={containerStyle} onLayout={handleLayout} testID={testID}>
      <Pressable
        testID={testID ? `${testID}-toggle` : undefined}
        style={fileHeaderPressableStyle}
        // Android: prevent parent pan/scroll gestures from canceling the tap release.
        cancelable={false}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={toggleExpanded}
      >
        <View style={styles.fileHeaderLeft}>
          <Text style={styles.fileName} numberOfLines={1}>
            {file.path.split("/").pop()}
          </Text>
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
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </View>
      </Pressable>
    </View>
  );
});

function DiffFileBody({
  file,
  layout,
  wrapLines,
  reviewActions,
  onBodyHeightChange,
  testID,
}: {
  file: ParsedDiffFile;
  layout: "unified" | "split";
  wrapLines: boolean;
  reviewActions?: InlineReviewActions;
  onBodyHeightChange?: (file: ParsedDiffFile, height: number) => void;
  testID?: string;
}) {
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [hoveredReviewTargetKey, setHoveredReviewTargetKey] = useState<string | null>(null);
  const { theme } = useUnistyles();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setBodyWidth(event.nativeEvent.layout.width);
      onBodyHeightChange?.(file, event.nativeEvent.layout.height);
    },
    [file, onBodyHeightChange],
  );

  const availableWidth = bodyWidth > 0 ? bodyWidth : scrollViewWidth;
  const linesContainerRowStyle = useMemo(
    () => [styles.linesContainer, availableWidth > 0 && { minWidth: availableWidth }],
    [availableWidth],
  );

  return (
    <View style={FILE_SECTION_BODY_STYLE} onLayout={handleLayout} testID={testID}>
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
          maxLineNo = Math.max(
            maxLineNo,
            hunk.oldStart + hunk.oldCount,
            hunk.newStart + hunk.newCount,
          );
        }
        const gutterWidth = lineNumberGutterWidth(maxLineNo, theme.fontSize.xs);

        if (layout === "split") {
          const rows = buildSplitDiffRows(file);
          return (
            <View style={DIFF_CONTENT_SPLIT_ROW_STYLE}>
              <SplitDiffColumn
                rows={rows}
                side="left"
                gutterWidth={gutterWidth}
                wrapLines={wrapLines}
                reviewActions={reviewActions}
              />
              <SplitDiffColumn
                rows={rows}
                side="right"
                gutterWidth={gutterWidth}
                wrapLines={wrapLines}
                reviewActions={reviewActions}
                showDivider
              />
            </View>
          );
        }

        const computedLines = buildUnifiedDiffLines(file);

        if (wrapLines) {
          return (
            <View style={styles.diffContent}>
              <View style={styles.linesContainer}>
                {computedLines.map(({ line, lineNumber, key, reviewTarget }) => (
                  <View key={key}>
                    <DiffLineView
                      line={line}
                      lineNumber={lineNumber}
                      gutterWidth={gutterWidth}
                      wrapLines={wrapLines}
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                    />
                    <InlineReviewRow
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                      gutterWidth={gutterWidth}
                    />
                  </View>
                ))}
              </View>
            </View>
          );
        }

        const textViewportWidth =
          scrollViewWidth > 0 ? scrollViewWidth : Math.max(0, bodyWidth - gutterWidth);
        return (
          <View style={DIFF_CONTENT_ROW_STYLE}>
            <View style={styles.gutterColumn}>
              {computedLines.map(({ line, lineNumber, key, reviewTarget }) => (
                <View key={key}>
                  <DiffGutterCell
                    lineNumber={lineNumber}
                    type={line.type}
                    gutterWidth={gutterWidth}
                    reviewTarget={reviewTarget}
                    reviewActions={reviewActions}
                    isLineHovered={
                      reviewTarget?.key !== undefined && hoveredReviewTargetKey === reviewTarget.key
                    }
                  />
                  <InlineReviewGutterSpacer
                    reviewTarget={reviewTarget}
                    reviewActions={reviewActions}
                    gutterWidth={gutterWidth}
                  />
                </View>
              ))}
            </View>
            <DiffScroll
              scrollViewWidth={scrollViewWidth}
              onScrollViewWidthChange={setScrollViewWidth}
              style={styles.splitColumnScroll}
              contentContainerStyle={styles.diffContentInner}
            >
              <View style={linesContainerRowStyle}>
                {computedLines.map(({ line, key, reviewTarget }) => (
                  <View key={key}>
                    <DiffTextLine
                      line={line}
                      wrapLines={false}
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                      hoverTargetKey={reviewTarget?.key ?? null}
                      onHoverTargetChange={setHoveredReviewTargetKey}
                    />
                    <InlineReviewThreadContent
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                      viewportWidth={textViewportWidth}
                      pinToViewport
                    />
                  </View>
                ))}
              </View>
            </DiffScroll>
          </View>
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
  enabled?: boolean;
}

type PressableStyleFn = (
  state: PressableStateCallbackType & { hovered?: boolean },
) => StyleProp<ViewStyle>;

interface DiffLayoutToggleGroupProps {
  layout: "unified" | "split";
  unifiedToggleStyle: PressableStyleFn;
  splitToggleStyle: PressableStyleFn;
  onUnified: () => void;
  onSplit: () => void;
}

function DiffLayoutToggleGroup({
  layout,
  unifiedToggleStyle,
  splitToggleStyle,
  onUnified,
  onSplit,
}: DiffLayoutToggleGroupProps) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.toggleButtonGroup}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Unified diff"
            testID="changes-layout-unified"
            onPress={onUnified}
            style={unifiedToggleStyle}
          >
            <AlignJustify
              size={14}
              color={layout === "unified" ? theme.colors.foreground : theme.colors.foregroundMuted}
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
            onPress={onSplit}
            style={splitToggleStyle}
          >
            <Columns2
              size={14}
              color={layout === "split" ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>Side-by-side diff</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

interface DiffWhitespaceToggleProps {
  hideWhitespace: boolean;
  isMobile: boolean;
  toggleStyle: PressableStyleFn;
  onToggle: () => void;
}

function DiffWhitespaceToggle({
  hideWhitespace,
  isMobile,
  toggleStyle,
  onToggle,
}: DiffWhitespaceToggleProps) {
  const { theme } = useUnistyles();
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide whitespace"
          testID="changes-toggle-whitespace"
          style={toggleStyle}
          onPress={onToggle}
        >
          <Pilcrow
            size={isMobile ? 18 : 14}
            color={hideWhitespace ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>Hide whitespace</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffFilesToolbarProps {
  wrapLines: boolean;
  allExpanded: boolean;
  isMobile: boolean;
  wrapLinesToggleStyle: PressableStyleFn;
  expandAllToggleStyle: PressableStyleFn;
  onToggleWrapLines: () => void;
  onToggleExpandAll: () => void;
}

function DiffFilesToolbar({
  wrapLines,
  allExpanded,
  isMobile,
  wrapLinesToggleStyle,
  expandAllToggleStyle,
  onToggleWrapLines,
  onToggleExpandAll,
}: DiffFilesToolbarProps) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.diffStatusButtons}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable style={wrapLinesToggleStyle} onPress={onToggleWrapLines}>
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
          <Pressable style={expandAllToggleStyle} onPress={onToggleExpandAll}>
            {allExpanded ? (
              <ListChevronsDownUp size={isMobile ? 18 : 14} color={theme.colors.foregroundMuted} />
            ) : (
              <ListChevronsUpDown size={isMobile ? 18 : 14} color={theme.colors.foregroundMuted} />
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
  );
}

type DiffFlatItem =
  | { type: "header"; file: ParsedDiffFile; fileIndex: number; isExpanded: boolean }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number };
type DiffFlatItemLayoutGetter = NonNullable<FlatListProps<DiffFlatItem>["getItemLayout"]>;

function getUnifiedDiffLineCount(file: ParsedDiffFile): number {
  let lineCount = 0;
  for (const hunk of file.hunks) {
    lineCount += hunk.lines.length;
  }
  return lineCount;
}

function getDiffContentLength(file: ParsedDiffFile): number {
  let contentLength = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      contentLength += line.content.length;
    }
  }
  return contentLength;
}

function computeBranchLabel(currentBranch: string | null | undefined, notGit: boolean): string {
  if (currentBranch && currentBranch !== "HEAD") {
    return currentBranch;
  }
  if (notGit) {
    return "Not a git repository";
  }
  return "Unknown";
}

function computeEmptyMessage(
  hideWhitespace: boolean,
  diffMode: "uncommitted" | "base",
  baseRefLabel: string,
): string {
  if (hideWhitespace) {
    return "No visible changes after hiding whitespace";
  }
  if (diffMode === "uncommitted") {
    return "No uncommitted changes";
  }
  return `No changes vs ${baseRefLabel}`;
}

interface DiffBodyContentProps {
  isStatusLoading: boolean;
  statusErrorMessage: string | null;
  notGit: boolean;
  isDiffLoading: boolean;
  diffErrorMessage: string | null;
  hasChanges: boolean;
  emptyMessage: string;
  flatItems: DiffFlatItem[];
  stickyHeaderIndices: number[];
  renderFlatItem: ({ item }: { item: DiffFlatItem }) => ReactElement;
  flatKeyExtractor: (item: DiffFlatItem) => string;
  getFlatItemLayout: DiffFlatItemLayoutGetter;
  flatExtraData: unknown;
  diffListRef: RefObject<FlatList<DiffFlatItem> | null>;
  handleDiffListLayout: (event: LayoutChangeEvent) => void;
  handleDiffListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: (width: number, height: number) => void;
  showDesktopWebScrollbar: boolean;
  foregroundMutedColor: string;
}

function DiffBodyContent({
  isStatusLoading,
  statusErrorMessage,
  notGit,
  isDiffLoading,
  diffErrorMessage,
  hasChanges,
  emptyMessage,
  flatItems,
  stickyHeaderIndices,
  renderFlatItem,
  flatKeyExtractor,
  getFlatItemLayout,
  flatExtraData,
  diffListRef,
  handleDiffListLayout,
  handleDiffListScroll,
  onContentSizeChange,
  showDesktopWebScrollbar,
  foregroundMutedColor,
}: DiffBodyContentProps) {
  if (isStatusLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={foregroundMutedColor} />
        <Text style={styles.loadingText}>Checking repository...</Text>
      </View>
    );
  }
  if (statusErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{statusErrorMessage}</Text>
      </View>
    );
  }
  if (notGit) {
    return (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={styles.emptyText}>Not a git repository</Text>
      </View>
    );
  }
  if (isDiffLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={foregroundMutedColor} />
      </View>
    );
  }
  if (diffErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{diffErrorMessage}</Text>
      </View>
    );
  }
  if (!hasChanges) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{emptyMessage}</Text>
      </View>
    );
  }
  return (
    <FlatList
      ref={diffListRef}
      data={flatItems}
      renderItem={renderFlatItem}
      keyExtractor={flatKeyExtractor}
      getItemLayout={getFlatItemLayout}
      stickyHeaderIndices={stickyHeaderIndices}
      extraData={flatExtraData}
      style={styles.scrollView}
      contentContainerStyle={styles.contentContainer}
      testID="git-diff-scroll"
      onLayout={handleDiffListLayout}
      onScroll={handleDiffListScroll}
      onContentSizeChange={onContentSizeChange}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={!showDesktopWebScrollbar}
      // Mixed-height rows (header + potentially very large body) are prone to clipping artifacts.
      // Keep a larger render window and disable clipping to avoid bodies disappearing mid-scroll.
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={10}
    />
  );
}

interface GitActionRunners {
  runCommit: (args: { serverId: string; cwd: string }) => Promise<void>;
  runPull: (args: { serverId: string; cwd: string }) => Promise<void>;
  runPush: (args: { serverId: string; cwd: string }) => Promise<void>;
  runPullAndPush: (args: { serverId: string; cwd: string }) => Promise<void>;
  runCreatePr: (args: { serverId: string; cwd: string }) => Promise<void>;
  runMergeBranch: (args: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
  runMergeFromBase: (args: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
  runArchiveWorktree: (args: {
    serverId: string;
    cwd: string;
    worktreePath: string;
  }) => Promise<void>;
}

interface GitActionHandlersDeps {
  serverId: string;
  cwd: string;
  baseRef: string | undefined;
  status: ReturnType<typeof useCheckoutStatusQuery>["status"];
  runners: GitActionRunners;
  persistShipDefault: (next: "merge" | "pr") => Promise<void>;
  toastError: (message: string) => void;
  toastActionError: (error: unknown, fallback: string) => void;
  toastActionSuccess: (message: string) => void;
  onMergeBranchSuccess: () => void;
  onArchiveSuccess: (targetWorkingDir: string) => void;
}

interface GitActionHandlers {
  handleCommit: () => void;
  handlePull: () => void;
  handlePush: () => void;
  handlePullAndPush: () => void;
  handleCreatePr: () => void;
  handleMergeBranch: () => void;
  handleMergeFromBase: () => void;
  handleArchiveWorktree: () => void;
}

function useGitActionHandlers({
  serverId,
  cwd,
  baseRef,
  status,
  runners,
  persistShipDefault,
  toastError,
  toastActionError,
  toastActionSuccess,
  onMergeBranchSuccess,
  onArchiveSuccess,
}: GitActionHandlersDeps): GitActionHandlers {
  const handleCommit = useCallback(() => {
    void runners
      .runCommit({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Committed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to commit");
      });
  }, [cwd, runners, serverId, toastActionError, toastActionSuccess]);

  const handlePull = useCallback(() => {
    void runners
      .runPull({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pulled");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to pull");
      });
  }, [cwd, runners, serverId, toastActionError, toastActionSuccess]);

  const handlePush = useCallback(() => {
    void runners
      .runPush({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pushed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to push");
      });
  }, [cwd, runners, serverId, toastActionError, toastActionSuccess]);

  const handlePullAndPush = useCallback(() => {
    void runners
      .runPullAndPush({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pulled and pushed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to pull and push");
      });
  }, [cwd, runners, serverId, toastActionError, toastActionSuccess]);

  const handleCreatePr = useCallback(() => {
    void persistShipDefault("pr");
    void runners
      .runCreatePr({ serverId, cwd })
      .then(() => {
        toastActionSuccess("PR created");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to create PR");
      });
  }, [cwd, persistShipDefault, runners, serverId, toastActionError, toastActionSuccess]);

  const handleMergeBranch = useCallback(() => {
    if (!baseRef) {
      toastError("Base ref unavailable");
      return;
    }
    void persistShipDefault("merge");
    void runners
      .runMergeBranch({ serverId, cwd, baseRef })
      .then(() => {
        onMergeBranchSuccess();
        toastActionSuccess("Merged");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to merge");
      });
  }, [
    baseRef,
    cwd,
    onMergeBranchSuccess,
    persistShipDefault,
    runners,
    serverId,
    toastActionError,
    toastActionSuccess,
    toastError,
  ]);

  const handleMergeFromBase = useCallback(() => {
    if (!baseRef) {
      toastError("Base ref unavailable");
      return;
    }
    void runners
      .runMergeFromBase({ serverId, cwd, baseRef })
      .then(() => {
        toastActionSuccess("Updated");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to merge from base");
      });
  }, [baseRef, cwd, runners, serverId, toastActionError, toastActionSuccess, toastError]);

  const handleArchiveWorktree = useCallback(() => {
    const worktreePath = status?.cwd;
    if (!worktreePath) {
      toastError("Worktree path unavailable");
      return;
    }
    const targetWorkingDir = resolveNewAgentWorkingDir(cwd, status ?? null);
    void runners
      .runArchiveWorktree({ serverId, cwd, worktreePath })
      .then(() => {
        onArchiveSuccess(targetWorkingDir);
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to archive worktree");
      });
  }, [cwd, onArchiveSuccess, runners, serverId, status, toastActionError, toastError]);

  return {
    handleCommit,
    handlePull,
    handlePush,
    handlePullAndPush,
    handleCreatePr,
    handleMergeBranch,
    handleMergeFromBase,
    handleArchiveWorktree,
  };
}

interface DeriveStatusStateInputs {
  status: ReturnType<typeof useCheckoutStatusQuery>["status"];
  isStatusLoading: boolean;
  isStatusError: boolean;
  statusError: unknown;
}

interface DerivedStatusState {
  gitStatus: NonNullable<ReturnType<typeof useCheckoutStatusQuery>["status"]> | null;
  isGit: boolean;
  notGit: boolean;
  statusErrorMessage: string | null;
  baseRef: string | undefined;
  hasUncommittedChanges: boolean;
  actionsDisabled: boolean;
}

function deriveStatusState({
  status,
  isStatusLoading,
  isStatusError,
  statusError,
}: DeriveStatusStateInputs): DerivedStatusState {
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  return {
    gitStatus,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    hasUncommittedChanges,
    actionsDisabled,
  };
}

interface DerivedBranchState {
  aheadCount: number;
  behindBaseCount: number;
  aheadOfOrigin: number;
  behindOfOrigin: number;
  hasPullRequest: boolean;
  hasRemote: boolean;
  isPaseoOwnedWorktree: boolean;
  isMergedPullRequest: boolean;
  currentBranch: string | null | undefined;
}

function deriveBranchState(
  gitStatus: DerivedStatusState["gitStatus"],
  prStatus: { url?: string | null; isMerged?: boolean | null } | null | undefined,
): DerivedBranchState {
  return {
    aheadCount: gitStatus?.aheadBehind?.ahead ?? 0,
    behindBaseCount: gitStatus?.aheadBehind?.behind ?? 0,
    aheadOfOrigin: gitStatus?.aheadOfOrigin ?? 0,
    behindOfOrigin: gitStatus?.behindOfOrigin ?? 0,
    hasPullRequest: Boolean(prStatus?.url),
    hasRemote: gitStatus?.hasRemote ?? false,
    isPaseoOwnedWorktree: gitStatus?.isPaseoOwnedWorktree ?? false,
    isMergedPullRequest: Boolean(prStatus?.isMerged),
    currentBranch: gitStatus?.currentBranch,
  };
}

function computeBaseRefLabel(baseRef: string | undefined): string {
  if (!baseRef) return "base";
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

function computeCommittedDiffDescription(
  branchLabel: string,
  baseRefLabel: string,
): string | undefined {
  if (!branchLabel || !baseRefLabel) {
    return undefined;
  }
  return branchLabel === baseRefLabel ? undefined : `${branchLabel} -> ${baseRefLabel}`;
}

function computeShouldPromoteArchive(
  isPaseoOwnedWorktree: boolean,
  hasUncommittedChanges: boolean,
  postShipArchiveSuggested: boolean,
  isMergedPullRequest: boolean,
): boolean {
  return (
    isPaseoOwnedWorktree &&
    !hasUncommittedChanges &&
    (postShipArchiveSuggested || isMergedPullRequest)
  );
}

function computeDisabledStates(
  actionsDisabled: boolean,
  statuses: GitActionsStatusInputs,
): GitActionsDisabledInputs {
  const pending = "pending";
  return {
    commitDisabled: actionsDisabled || statuses.commitStatus === pending,
    pullDisabled: actionsDisabled || statuses.pullStatus === pending,
    pushDisabled: actionsDisabled || statuses.pushStatus === pending,
    pullAndPushDisabled: actionsDisabled || statuses.pullAndPushStatus === pending,
    prDisabled: actionsDisabled || statuses.prCreateStatus === pending,
    mergeDisabled: actionsDisabled || statuses.mergeStatus === pending,
    mergeFromBaseDisabled: actionsDisabled || statuses.mergeFromBaseStatus === pending,
    archiveDisabled: actionsDisabled || statuses.archiveStatus === pending,
  };
}

function computePrErrorMessage(
  githubFeaturesEnabled: boolean,
  prPayloadError: { message?: string } | null | undefined,
): string | null {
  if (!githubFeaturesEnabled) return null;
  return prPayloadError?.message ?? null;
}

function buildToggleButtonStyle(
  selected: boolean,
  baseStyles: StyleProp<ViewStyle> | StyleProp<ViewStyle>[],
): PressableStyleFn {
  return ({ hovered, pressed }) => [
    baseStyles,
    selected && styles.toggleButtonSelected,
    (Boolean(hovered) || pressed) && styles.diffStatusRowHovered,
  ];
}

function createPrHandler(
  prStatus: { url?: string | null } | null | undefined,
  handleCreatePr: () => void,
): () => void {
  return () => {
    if (prStatus?.url) {
      openURLInNewTab(prStatus.url);
      return;
    }
    handleCreatePr();
  };
}

interface GitActionsStatusInputs {
  commitStatus: CheckoutGitActionStatus;
  pullStatus: CheckoutGitActionStatus;
  pushStatus: CheckoutGitActionStatus;
  pullAndPushStatus: CheckoutGitActionStatus;
  prCreateStatus: CheckoutGitActionStatus;
  mergeStatus: CheckoutGitActionStatus;
  mergeFromBaseStatus: CheckoutGitActionStatus;
  archiveStatus: CheckoutGitActionStatus;
}

interface GitActionsDisabledInputs {
  commitDisabled: boolean;
  pullDisabled: boolean;
  pushDisabled: boolean;
  pullAndPushDisabled: boolean;
  prDisabled: boolean;
  mergeDisabled: boolean;
  mergeFromBaseDisabled: boolean;
  archiveDisabled: boolean;
}

interface BuildGitActionsParams {
  policy: {
    isGit: boolean;
    githubFeaturesEnabled: boolean;
    hasPullRequest: boolean;
    pullRequestUrl: string | null;
    hasRemote: boolean;
    isPaseoOwnedWorktree: boolean;
    isOnBaseBranch: boolean;
    hasUncommittedChanges: boolean;
    baseRefAvailable: boolean;
    baseRefLabel: string;
    aheadCount: number;
    behindBaseCount: number;
    aheadOfOrigin: number;
    behindOfOrigin: number;
    shouldPromoteArchive: boolean;
    shipDefault: "merge" | "pr";
  };
  statuses: GitActionsStatusInputs;
  disabled: GitActionsDisabledInputs;
  handlers: GitActionHandlers & { handlePr: () => void };
  iconColor: string;
}

function buildGitActionsForPane({
  policy,
  statuses,
  disabled,
  handlers,
  iconColor,
}: BuildGitActionsParams): GitActions {
  return buildGitActions({
    ...policy,
    runtime: {
      commit: {
        disabled: disabled.commitDisabled,
        status: statuses.commitStatus,
        icon: <GitCommitHorizontal size={16} color={iconColor} />,
        handler: handlers.handleCommit,
      },
      pull: {
        disabled: disabled.pullDisabled,
        status: statuses.pullStatus,
        icon: <Download size={16} color={iconColor} />,
        handler: handlers.handlePull,
      },
      push: {
        disabled: disabled.pushDisabled,
        status: statuses.pushStatus,
        icon: <Upload size={16} color={iconColor} />,
        handler: handlers.handlePush,
      },
      "pull-and-push": {
        disabled: disabled.pullAndPushDisabled,
        status: statuses.pullAndPushStatus,
        icon: <ArrowDownUp size={16} color={iconColor} />,
        handler: handlers.handlePullAndPush,
      },
      pr: {
        disabled: disabled.prDisabled,
        status: policy.hasPullRequest ? "idle" : statuses.prCreateStatus,
        icon: <GitHubIcon size={16} color={iconColor} />,
        handler: handlers.handlePr,
      },
      "merge-branch": {
        disabled: disabled.mergeDisabled,
        status: statuses.mergeStatus,
        icon: <GitMerge size={16} color={iconColor} />,
        handler: handlers.handleMergeBranch,
      },
      "merge-from-base": {
        disabled: disabled.mergeFromBaseDisabled,
        status: statuses.mergeFromBaseStatus,
        icon: <RefreshCcw size={16} color={iconColor} />,
        handler: handlers.handleMergeFromBase,
      },
      "archive-worktree": {
        disabled: disabled.archiveDisabled,
        status: statuses.archiveStatus,
        icon: <Archive size={16} color={iconColor} />,
        handler: handlers.handleArchiveWorktree,
      },
    },
  });
}

function shouldEnableCheckoutDiff(input: { paneEnabled: boolean; isGit: boolean }): boolean {
  return input.paneEnabled && input.isGit;
}

export function GitDiffPane({
  serverId,
  workspaceId,
  cwd,
  hideHeaderRow,
  enabled,
}: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const isMobile = useIsCompactFormFactor();
  const showDesktopWebScrollbar = isWeb && !isMobile;
  const canUseSplitLayout = isWeb && !isMobile;
  const router = useRouter();
  const [diffModeOverride, setDiffModeOverride] = useState<ReviewDraftMode | null>(null);
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

  // handleSelectUncommitted/handleSelectBase are defined later, after reviewDraftScopeKey
  // and setActiveReviewMode are available, so they can record the active review mode.

  const handleLayoutUnified = useCallback(() => {
    handleLayoutChange("unified");
  }, [handleLayoutChange]);

  const handleLayoutSplit = useCallback(() => {
    handleLayoutChange("split");
  }, [handleLayoutChange]);

  const unifiedToggleStyle = useMemo(
    () =>
      buildToggleButtonStyle(changesPreferences.layout === "unified", [
        styles.toggleButton,
        styles.toggleButtonGroupStart,
      ]),
    [changesPreferences.layout],
  );

  const splitToggleStyle = useMemo(
    () =>
      buildToggleButtonStyle(changesPreferences.layout === "split", [
        styles.toggleButton,
        styles.toggleButtonGroupEnd,
      ]),
    [changesPreferences.layout],
  );

  const hideWhitespaceToggleStyle = useMemo(
    () => buildToggleButtonStyle(changesPreferences.hideWhitespace, styles.expandAllButton),
    [changesPreferences.hideWhitespace],
  );

  const wrapLinesToggleStyle = useMemo(
    () => buildToggleButtonStyle(wrapLines, styles.expandAllButton),
    [wrapLines],
  );

  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const statusState = deriveStatusState({ status, isStatusLoading, isStatusError, statusError });
  const {
    gitStatus,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    hasUncommittedChanges,
    actionsDisabled,
  } = statusState;

  // Auto-select diff mode based on state: uncommitted when dirty, base when clean
  const autoDiffMode: ReviewDraftMode = hasUncommittedChanges ? "uncommitted" : "base";
  const reviewDraftScopeKey = useMemo(
    () =>
      buildReviewDraftScopeKey({
        serverId,
        workspaceId,
        cwd,
        baseRef,
        ignoreWhitespace: changesPreferences.hideWhitespace,
      }),
    [baseRef, changesPreferences.hideWhitespace, cwd, serverId, workspaceId],
  );
  const activeReviewMode = useActiveReviewDraftMode({ scopeKey: reviewDraftScopeKey });
  const diffMode = diffModeOverride ?? activeReviewMode ?? autoDiffMode;

  const {
    files,
    payloadError: diffPayloadError,
    isLoading: isDiffLoading,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    ignoreWhitespace: changesPreferences.hideWhitespace,
    enabled: shouldEnableCheckoutDiff({ paneEnabled: enabled !== false, isGit }),
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef,
        ignoreWhitespace: changesPreferences.hideWhitespace,
      }),
    [baseRef, changesPreferences.hideWhitespace, cwd, diffMode, serverId, workspaceId],
  );
  const setActiveReviewMode = useSetActiveReviewDraftMode();

  const handleSelectUncommitted = useCallback(() => {
    setDiffModeOverride("uncommitted");
    setActiveReviewMode({ scopeKey: reviewDraftScopeKey, mode: "uncommitted" });
  }, [reviewDraftScopeKey, setActiveReviewMode]);

  const handleSelectBase = useCallback(() => {
    setDiffModeOverride("base");
    setActiveReviewMode({ scopeKey: reviewDraftScopeKey, mode: "base" });
  }, [reviewDraftScopeKey, setActiveReviewMode]);

  const reviewActions = useInlineReviewController({
    reviewDraftKey,
  });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef,
  });
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    setWorkspaceAttachments({
      scopeKey: workspaceAttachmentScopeKey,
      attachments: reviewAttachment ? [reviewAttachment] : [],
    });

    return () => {
      clearWorkspaceAttachments({ scopeKey: workspaceAttachmentScopeKey });
    };
  }, [
    clearWorkspaceAttachments,
    reviewAttachment,
    setWorkspaceAttachments,
    workspaceAttachmentScopeKey,
  ]);
  const {
    status: prStatus,
    githubFeaturesEnabled,
    payloadError: prPayloadError,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
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
  const expandedPaths = useMemo(() => new Set(expandedPathsArray ?? []), [expandedPathsArray]);
  const diffListRef = useRef<FlatList<DiffFlatItem>>(null);
  const scrollbar = useWebScrollViewScrollbar(diffListRef, {
    enabled: showDesktopWebScrollbar,
  });
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByKeyRef = useRef<Record<string, number>>({});
  const defaultHeaderHeightRef = useRef<number>(44);
  const [heightVersion, setHeightVersion] = useState(0);
  const diffBodyLineHeight = theme.lineHeight.diff;
  const diffBodyChromeHeight = theme.borderWidth[1] * 2;
  const statusBodyHeightEstimate = diffBodyChromeHeight + theme.spacing[4] * 2 + diffBodyLineHeight;
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
        return;
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

  const getBodyHeightKey = useCallback(
    (file: ParsedDiffFile): string => {
      if (file.status === "too_large" || file.status === "binary") {
        return `${effectiveLayout}:${wrapLines ? "wrap" : "scroll"}:${file.path}:${file.status}`;
      }

      return [
        effectiveLayout,
        wrapLines ? "wrap" : "scroll",
        file.path,
        file.status ?? "ok",
        file.additions,
        file.deletions,
        file.hunks.length,
        getUnifiedDiffLineCount(file),
        getDiffContentLength(file),
      ].join(":");
    },
    [effectiveLayout, wrapLines],
  );

  const estimateBodyHeight = useCallback(
    (file: ParsedDiffFile): number => {
      if (file.status === "too_large" || file.status === "binary") {
        return statusBodyHeightEstimate;
      }

      const lineCount =
        effectiveLayout === "split"
          ? buildSplitDiffRows(file).length
          : getUnifiedDiffLineCount(file);
      return diffBodyChromeHeight + lineCount * diffBodyLineHeight;
    },
    [diffBodyChromeHeight, diffBodyLineHeight, effectiveLayout, statusBodyHeightEstimate],
  );

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previousHeight = headerHeightByPathRef.current[path];
    if (
      previousHeight !== undefined &&
      Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
    ) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    defaultHeaderHeightRef.current = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleBodyHeightChange = useCallback(
    (file: ParsedDiffFile, height: number) => {
      if (!Number.isFinite(height) || height < 0) {
        return;
      }
      const heightKey = getBodyHeightKey(file);
      const previousHeight = bodyHeightByKeyRef.current[heightKey];
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
      ) {
        return;
      }
      bodyHeightByKeyRef.current[heightKey] = height;
      setHeightVersion((version) => version + 1);
    },
    [getBodyHeightKey],
  );

  const handleDiffListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      diffListScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
      scrollbar.onScroll(event);
    },
    [scrollbar],
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
    [scrollbar],
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
          const bodyHeightKey = getBodyHeightKey(file);
          offset += bodyHeightByKeyRef.current[bodyHeightKey] ?? estimateBodyHeight(file);
        }
      }
      return Math.max(0, offset);
    },
    [estimateBodyHeight, expandedPaths, files, getBodyHeightKey],
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

  // Clear diff mode override when auto mode changes (e.g., after commit)
  useEffect(() => {
    setDiffModeOverride(null);
  }, [autoDiffMode]);

  const commitStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "commit" }),
  );
  const pullStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "pull" }),
  );
  const pushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "push" }),
  );
  const pullAndPushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "pull-and-push" }),
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
  const runPull = useCheckoutGitActionsStore((state) => state.pull);
  const runPush = useCheckoutGitActionsStore((state) => state.push);
  const runPullAndPush = useCheckoutGitActionsStore((state) => state.pullAndPush);
  const runCreatePr = useCheckoutGitActionsStore((state) => state.createPr);
  const runMergeBranch = useCheckoutGitActionsStore((state) => state.mergeBranch);
  const runMergeFromBase = useCheckoutGitActionsStore((state) => state.mergeFromBase);
  const runArchiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);

  const toastActionError = useCallback(
    (error: unknown, fallback: string) => {
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message);
    },
    [toast],
  );

  const toastActionSuccess = useCallback(
    (message: string) => {
      toast.show(message, { variant: "success" });
    },
    [toast],
  );

  const handleMergeBranchSuccess = useCallback(() => {
    setPostShipArchiveSuggested(true);
  }, []);

  const handleArchiveSuccess = useCallback(
    (targetWorkingDir: string) => {
      router.replace(buildNewAgentRoute(serverId, targetWorkingDir));
    },
    [router, serverId],
  );

  const toastError = useCallback(
    (message: string) => {
      toast.error(message);
    },
    [toast],
  );

  const runners = useMemo<GitActionRunners>(
    () => ({
      runCommit,
      runPull,
      runPush,
      runPullAndPush,
      runCreatePr,
      runMergeBranch,
      runMergeFromBase,
      runArchiveWorktree,
    }),
    [
      runArchiveWorktree,
      runCommit,
      runCreatePr,
      runMergeBranch,
      runMergeFromBase,
      runPull,
      runPullAndPush,
      runPush,
    ],
  );

  const {
    handleCommit,
    handlePull,
    handlePush,
    handlePullAndPush,
    handleCreatePr,
    handleMergeBranch,
    handleMergeFromBase,
    handleArchiveWorktree,
  } = useGitActionHandlers({
    serverId,
    cwd,
    baseRef,
    status,
    runners,
    persistShipDefault,
    toastError,
    toastActionError,
    toastActionSuccess,
    onMergeBranchSuccess: handleMergeBranchSuccess,
    onArchiveSuccess: handleArchiveSuccess,
  });

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffFlatItem }) => {
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            isExpanded={item.isExpanded}
            onToggle={handleToggleExpanded}
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
          reviewActions={reviewActions}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-file-${item.fileIndex}-body`}
        />
      );
    },
    [
      effectiveLayout,
      handleBodyHeightChange,
      handleHeaderHeightChange,
      handleToggleExpanded,
      reviewActions,
      wrapLines,
    ],
  );

  const flatKeyExtractor = useCallback(
    (item: DiffFlatItem) => `${item.type}-${item.file.path}`,
    [],
  );

  const getFlatItemHeight = useCallback(
    (item: DiffFlatItem): number => {
      if (item.type === "header") {
        return headerHeightByPathRef.current[item.file.path] ?? defaultHeaderHeightRef.current;
      }

      const bodyHeightKey = getBodyHeightKey(item.file);
      return bodyHeightByKeyRef.current[bodyHeightKey] ?? estimateBodyHeight(item.file);
    },
    [estimateBodyHeight, getBodyHeightKey],
  );

  const getFlatItemLayout = useCallback<DiffFlatItemLayoutGetter>(
    (_data, index) => {
      let offset = 0;
      for (let itemIndex = 0; itemIndex < index; itemIndex += 1) {
        const item = flatItems[itemIndex];
        if (item) {
          offset += getFlatItemHeight(item);
        }
      }

      const item = flatItems[index];
      const length = item ? getFlatItemHeight(item) : 0;
      return { length, offset, index };
    },
    [flatItems, getFlatItemHeight],
  );

  const flatExtraData = useMemo(
    () => ({
      expandedPathsArray,
      effectiveLayout,
      heightVersion,
      wrapLines,
      reviewActions,
    }),
    [expandedPathsArray, effectiveLayout, heightVersion, wrapLines, reviewActions],
  );

  const hasChanges = files.length > 0;
  const diffErrorMessage = diffPayloadError?.message ?? null;
  const prErrorMessage = computePrErrorMessage(githubFeaturesEnabled, prPayloadError);
  const branchLabel = computeBranchLabel(gitStatus?.currentBranch, notGit);
  const branchState = useMemo(() => deriveBranchState(gitStatus, prStatus), [gitStatus, prStatus]);
  const {
    aheadCount,
    behindBaseCount,
    aheadOfOrigin,
    behindOfOrigin,
    hasPullRequest,
    hasRemote,
    isPaseoOwnedWorktree,
    isMergedPullRequest,
    currentBranch,
  } = branchState;
  const baseRefLabel = useMemo(() => computeBaseRefLabel(baseRef), [baseRef]);
  const committedDiffDescription = useMemo(
    () => computeCommittedDiffDescription(branchLabel, baseRefLabel),
    [baseRefLabel, branchLabel],
  );
  const isOnBaseBranch = currentBranch === baseRefLabel;
  const shouldPromoteArchive = computeShouldPromoteArchive(
    isPaseoOwnedWorktree,
    hasUncommittedChanges,
    postShipArchiveSuggested,
    isMergedPullRequest,
  );

  const gitActionsStatuses = useMemo<GitActionsStatusInputs>(
    () => ({
      commitStatus,
      pullStatus,
      pushStatus,
      pullAndPushStatus,
      prCreateStatus,
      mergeStatus,
      mergeFromBaseStatus,
      archiveStatus,
    }),
    [
      archiveStatus,
      commitStatus,
      mergeFromBaseStatus,
      mergeStatus,
      prCreateStatus,
      pullAndPushStatus,
      pullStatus,
      pushStatus,
    ],
  );

  const gitActionsDisabled = useMemo<GitActionsDisabledInputs>(
    () => computeDisabledStates(actionsDisabled, gitActionsStatuses),
    [actionsDisabled, gitActionsStatuses],
  );

  const emptyMessage = computeEmptyMessage(
    changesPreferences.hideWhitespace,
    diffMode,
    baseRefLabel,
  );

  const bodyContent: ReactElement = (
    <DiffBodyContent
      isStatusLoading={isStatusLoading}
      statusErrorMessage={statusErrorMessage}
      notGit={notGit}
      isDiffLoading={isDiffLoading}
      diffErrorMessage={diffErrorMessage}
      hasChanges={hasChanges}
      emptyMessage={emptyMessage}
      flatItems={flatItems}
      stickyHeaderIndices={stickyHeaderIndices}
      renderFlatItem={renderFlatItem}
      flatKeyExtractor={flatKeyExtractor}
      getFlatItemLayout={getFlatItemLayout}
      flatExtraData={flatExtraData}
      diffListRef={diffListRef}
      handleDiffListLayout={handleDiffListLayout}
      handleDiffListScroll={handleDiffListScroll}
      onContentSizeChange={scrollbar.onContentSizeChange}
      showDesktopWebScrollbar={showDesktopWebScrollbar}
      foregroundMutedColor={theme.colors.foregroundMuted}
    />
  );

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

  const handlePr = useMemo(
    () => createPrHandler(prStatus, handleCreatePr),
    [handleCreatePr, prStatus],
  );

  const gitActionsHandlers = useMemo(
    () => ({
      handleCommit,
      handlePull,
      handlePush,
      handlePullAndPush,
      handleCreatePr,
      handleMergeBranch,
      handleMergeFromBase,
      handleArchiveWorktree,
      handlePr,
    }),
    [
      handleArchiveWorktree,
      handleCommit,
      handleCreatePr,
      handleMergeBranch,
      handleMergeFromBase,
      handlePr,
      handlePull,
      handlePullAndPush,
      handlePush,
    ],
  );

  const gitActions: GitActions = useMemo(
    () =>
      buildGitActionsForPane({
        policy: {
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
          behindBaseCount,
          aheadOfOrigin,
          behindOfOrigin,
          shouldPromoteArchive,
          shipDefault,
        },
        statuses: gitActionsStatuses,
        disabled: gitActionsDisabled,
        handlers: gitActionsHandlers,
        iconColor: theme.colors.foregroundMuted,
      }),
    [
      aheadCount,
      aheadOfOrigin,
      baseRef,
      baseRefLabel,
      behindBaseCount,
      behindOfOrigin,
      gitActionsDisabled,
      gitActionsHandlers,
      gitActionsStatuses,
      githubFeaturesEnabled,
      hasPullRequest,
      hasRemote,
      hasUncommittedChanges,
      isGit,
      isOnBaseBranch,
      isPaseoOwnedWorktree,
      prStatus?.url,
      shipDefault,
      shouldPromoteArchive,
      theme.colors.foregroundMuted,
    ],
  );

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
                style={diffModeTriggerStyle}
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
                  onSelect={handleSelectUncommitted}
                >
                  Uncommitted
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  testID="changes-diff-mode-committed"
                  selected={diffMode === "base"}
                  description={committedDiffDescription}
                  onSelect={handleSelectBase}
                >
                  Committed
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <View style={styles.diffStatusButtons}>
              {canUseSplitLayout ? (
                <DiffLayoutToggleGroup
                  layout={changesPreferences.layout}
                  unifiedToggleStyle={unifiedToggleStyle}
                  splitToggleStyle={splitToggleStyle}
                  onUnified={handleLayoutUnified}
                  onSplit={handleLayoutSplit}
                />
              ) : null}
              <DiffWhitespaceToggle
                hideWhitespace={changesPreferences.hideWhitespace}
                isMobile={isMobile}
                toggleStyle={hideWhitespaceToggleStyle}
                onToggle={handleToggleHideWhitespace}
              />
              {files.length > 0 ? (
                <DiffFilesToolbar
                  wrapLines={wrapLines}
                  allExpanded={allExpanded}
                  isMobile={isMobile}
                  wrapLinesToggleStyle={wrapLinesToggleStyle}
                  expandAllToggleStyle={expandAllButtonStyle}
                  onToggleWrapLines={handleToggleWrapLines}
                  onToggleExpandAll={handleToggleExpandAll}
                />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

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
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    minWidth: 0,
    zIndex: 2,
    elevation: 2,
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
    flexShrink: 1,
    minWidth: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
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
    color: theme.colors.diffAddition,
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
    color: theme.colors.diffDeletion,
  },
  additions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
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
  gutterColumn: {
    backgroundColor: theme.colors.surface1,
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  gutterCell: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    justifyContent: "flex-start",
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  inlineReviewRow: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: theme.colors.surface1,
  },
  inlineReviewGutterSpacer: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexShrink: 0,
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
    overflow: "visible",
  },
  lineNumberGutter: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    marginRight: theme.spacing[2],
    alignSelf: "stretch",
    justifyContent: "flex-start",
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  lineNumberText: {
    width: "100%",
    textAlign: "right",
    paddingRight: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.lineHeight.diff,
    fontFamily: Fonts.mono,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  addLineNumberText: {
    color: theme.colors.diffAddition,
  },
  removeLineNumberText: {
    color: theme.colors.diffDeletion,
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
  contextLineContainer: {
    backgroundColor: theme.colors.surface1,
  },
  contextLineText: {
    color: theme.colors.foregroundMuted,
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

const HEADER_LINE_TEXT_STYLE = [styles.diffLineText, styles.headerLineText];
const FILE_SECTION_BODY_STYLE = [styles.fileSectionBodyContainer, styles.fileSectionBorder];
const DIFF_CONTENT_SPLIT_ROW_STYLE = [styles.diffContent, styles.splitRow];
const DIFF_CONTENT_ROW_STYLE = [styles.diffContent, styles.diffContentRow];
const DIFF_HEIGHT_CHANGE_EPSILON = 0.5;
