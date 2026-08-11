import {
  Fragment,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DiffStat } from "@/components/diff-stat";
import {
  View,
  Text,
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
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BORDER_WIDTH, ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import {
  AlignJustify,
  ChevronDown,
  Columns2,
  FolderTree,
  List,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Maximize2,
  Pilcrow,
  RotateCw,
  WrapText,
} from "lucide-react-native";
import { type ParsedDiffFile, type DiffLine, type HighlightToken } from "@/git/use-diff-query";
import { buildDiffTree, collectDirPaths, compressSingleChildChains } from "@/git/diff-tree";
import { DiffFolderRow } from "@/git/diff-folder-row";
import {
  TreeIndentGuides,
  treeRowPaddingLeft,
  WORKSPACE_FILE_ROW_TRAILING_PADDING,
  WORKSPACE_FILE_ROW_VERTICAL_PADDING,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { FileChangeIcon } from "@/components/file-change-icon";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { CommitsSection } from "@/git/commits-section/commits-section";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { shouldAnchorHeaderBeforeCollapse } from "@/git/diff-scroll";
import {
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
import * as Clipboard from "expo-clipboard";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { BranchSwitcher } from "@/components/branch-switcher";
import { useGitActions } from "@/git/use-actions";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { buildForgeSignInCommand, getForgePresentation, type Forge } from "@/git/forge";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useOverlayFlatListScrollbar } from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { usePanelStore } from "@/stores/panel-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
  compactHighlightTokens,
} from "@/utils/diff-rendering";
import { isWeb, isNative } from "@/constants/platform";
import { useWorkspaceFileDragSource } from "@/attachments/use-workspace-file-drag-source";
import {
  type ReviewDraftComment,
  getInlineReviewThreadState,
  getSplitInlineReviewThreadState,
  InlineReviewGutterCell,
  InlineReviewThread,
  isInlineReviewEditorForTarget,
  type InlineReviewActions,
} from "@/review";
import { usePublishWorkingDiffAttachment, useWorkingDiff } from "@/git/use-working-diff";
import { DiffTooLargeState } from "@/git/diff-too-large-state";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import {
  buildDiffRowIndex,
  createDiffRowCache,
  DIFF_VIRTUALIZATION_CONFIG,
  type DiffListItem,
  type SplitRowGroupItem,
  type UnifiedRowGroupItem,
} from "@/git/diff-rows/model";
import { DiffHorizontalContent, DiffHorizontalSurface } from "@/git/diff-horizontal-surface";

export type { GitActionId, GitAction, GitActions } from "@/git/policy";

export function resolveDiffLayout(
  layout: "unified" | "split",
  canUseSplitLayout: boolean,
): "unified" | "split" {
  return canUseSplitLayout ? layout : "unified";
}

function fileHeaderPressableStyle(
  { hovered, pressed }: PressableStateCallbackType & { hovered?: boolean },
  isSelected: boolean,
) {
  return [
    styles.fileHeader,
    (Boolean(hovered) || pressed || isSelected) && styles.fileHeaderActive,
  ];
}

interface HighlightedTextProps {
  tokens: HighlightToken[];
  textMetricsStyle: TextStyle;
  wrapLines?: boolean;
  testID?: string;
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

function getNumericLineHeight(textMetricsStyle: TextStyle): number | undefined {
  const { lineHeight } = textMetricsStyle;
  return typeof lineHeight === "number" && Number.isFinite(lineHeight) ? lineHeight : undefined;
}

function useDiffRowMetricsStyle(textMetricsStyle: TextStyle): StyleProp<ViewStyle> {
  const lineHeight = getNumericLineHeight(textMetricsStyle);
  return useMemo(
    () => (lineHeight !== undefined ? inlineUnistylesStyle({ minHeight: lineHeight }) : null),
    [lineHeight],
  );
}

function HighlightedText({
  tokens,
  textMetricsStyle,
  wrapLines = false,
  testID,
}: HighlightedTextProps) {
  const containerStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
    ],
    [textMetricsStyle, wrapLines],
  );

  const keyedTokens = useMemo(() => {
    let characterOffset = 0;
    return compactHighlightTokens(tokens).map((token) => {
      const keyedToken = { key: `${characterOffset}-${token.style ?? "base"}`, token };
      characterOffset += token.text.length;
      return keyedToken;
    });
  }, [tokens]);

  return (
    <Text style={containerStyle} testID={testID}>
      {keyedTokens.map(({ key, token }) => (
        <Text key={key} style={syntaxTokenStyleFor(token.style)}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

interface DiffFileSectionProps {
  file: ParsedDiffFile;
  workspaceFileDragScope?: { serverId: string; workspaceId: string };
  isExpanded: boolean;
  isSelected?: boolean;
  /** Tree indentation level (0 on the flat/mobile path). */
  depth?: number;
  /** Show the muted directory suffix (flat list); false inside the folder tree. */
  showDir?: boolean;
  interactive?: boolean;
  onToggle?: (path: string) => void;
  onSelect?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onAddToChat?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  onCopyRelativePath?: (path: string) => void;
  onReveal?: (path: string) => void;
  revealTargetName?: string;
  onDownload?: (path: string) => void;
  onDuplicate?: (path: string) => void;
  onRevert?: (path: string, oldPath?: string) => void;
  onHeaderHeightChange?: (path: string, height: number) => void;
  testID?: string;
}

const EMPTY_COMMENTS: readonly ReviewDraftComment[] = [];

function noopStartComment(): void {}

function useDiscardChangesAction({
  serverId,
  cwd,
  diffMode,
}: {
  serverId: string;
  cwd: string;
  diffMode: "uncommitted" | "base";
}): ((path: string, oldPath?: string) => void) | undefined {
  const { t } = useTranslation();
  const toast = useToast();
  const discardChanges = useCheckoutGitActionsStore((state) => state.discardChanges);
  // COMPAT(checkoutDiscardChanges): added in v0.3.0, remove gate after 2027-02-08.
  const discardSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutDiscardChanges === true,
  );
  const discardPath = useCallback(
    async (path: string, oldPath?: string) => {
      const confirmed = await confirmDialog({
        title: t("workspace.fileActions.confirmRevert.title"),
        message: t("workspace.fileActions.confirmRevert.message", { name: path }),
        confirmLabel: t("workspace.fileActions.confirmRevert.confirm"),
        cancelLabel: t("workspace.fileActions.confirmRevert.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        await discardChanges({
          serverId,
          cwd,
          paths: oldPath ? [path, oldPath] : [path],
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileActions.confirmRevert.failed"),
        );
      }
    },
    [cwd, discardChanges, serverId, t, toast],
  );
  const handleDiscardPath = useCallback(
    (path: string, oldPath?: string) => {
      void discardPath(path, oldPath);
    },
    [discardPath],
  );
  return discardSupported && diffMode === "uncommitted" ? handleDiscardPath : undefined;
}

const DIFF_LINE_HOVER_STYLE = isWeb ? ({ cursor: "auto" } as const) : null;

function LongPressableLine({
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
  style,
  testID,
  children,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions: InlineReviewActions | undefined;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
  style: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}) {
  const onStartComment = reviewActions?.onStartComment;
  const handlePress = useCallback(() => {
    const selection = isWeb ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
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
      <Pressable
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={hoverStyle}
        testID={testID}
      >
        {children}
      </Pressable>
    );
  }

  if (!isNative || !reviewTarget || !onStartComment) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable onPress={handlePress} style={style} testID={testID}>
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
  textMetricsStyle,
  reviewTarget,
  reviewActions,
  isLineHovered,
  style,
  textTestID,
  actionTestID,
  rowTestID,
}: {
  lineNumber: number | null;
  type: DiffLine["type"] | undefined | null;
  gutterWidth: number;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  isLineHovered?: boolean;
  style?: StyleProp<ViewStyle>;
  textTestID?: string;
  actionTestID?: string;
  rowTestID?: string;
}) {
  const lineHeight = getNumericLineHeight(textMetricsStyle);
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);
  const containerStyle = useMemo(
    () => [
      styles.gutterCell,
      lineTypeBackground(type),
      rowMetricsStyle,
      inlineUnistylesStyle({ width: gutterWidth }),
      style,
    ],
    [type, rowMetricsStyle, gutterWidth, style],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.lineNumberText,
      type === "add" && styles.addLineNumberText,
      type === "remove" && styles.removeLineNumberText,
    ],
    [textMetricsStyle, type],
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
      lineHeight={lineHeight}
      onStartComment={onStartComment}
      style={containerStyle}
      actionTestID={actionTestID}
      testID={rowTestID}
    >
      <Text numberOfLines={1} style={textStyle} testID={textTestID}>
        {formatDiffGutterText(lineNumber)}
      </Text>
    </InlineReviewGutterCell>
  );
}

function DiffTextLine({
  line,
  wrapLines,
  textMetricsStyle,
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
  textTestID,
  rowTestID,
}: {
  line: DiffLine;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
  textTestID?: string;
  rowTestID?: string;
}) {
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line.type), rowMetricsStyle],
    [line.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, textMetricsStyle, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={onHoverChange}
      hoverTargetKey={hoverTargetKey}
      onHoverTargetChange={onHoverTargetChange}
      style={containerStyle}
      testID={rowTestID}
    >
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
          testID={textTestID}
        />
      ) : (
        <Text style={textStyle} testID={textTestID}>
          {formatDiffContentText(line.content)}
        </Text>
      )}
    </LongPressableLine>
  );
}

function SplitTextLine({
  line,
  wrapLines,
  textMetricsStyle,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
}: {
  line: SplitDiffDisplayLine | null;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
}) {
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line?.type), rowMetricsStyle],
    [line?.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, textMetricsStyle, wrapLines],
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
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
        />
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
  textMetricsStyle,
  reviewTarget,
  reviewActions,
}: {
  line: DiffLine;
  lineNumber: number | null;
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line.type), rowMetricsStyle],
    [line.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, textMetricsStyle, wrapLines],
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
        textMetricsStyle={textMetricsStyle}
        reviewTarget={reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
        />
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
  textMetricsStyle,
  reviewActions,
}: {
  line: SplitDiffDisplayLine | null;
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line?.type), rowMetricsStyle],
    [line?.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, textMetricsStyle, wrapLines],
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
        textMetricsStyle={textMetricsStyle}
        reviewTarget={line?.reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
        />
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
  const placeholderStyle = useMemo<ViewStyle>(
    () => inlineUnistylesStyle({ minHeight: height }),
    [height],
  );
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
    () => [
      styles.inlineReviewGutterSpacer,
      inlineUnistylesStyle({ width: gutterWidth, minHeight: height }),
      style,
    ],
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
    () => [styles.inlineReviewGutterSpacer, inlineUnistylesStyle({ width: gutterWidth })],
    [gutterWidth],
  );
  const placeholderStyle = useMemo<ViewStyle>(
    () => inlineUnistylesStyle({ minHeight: height }),
    [height],
  );
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
  textMetricsStyle,
  reviewActions,
  startRowIndex,
  minContentWidth,
  textViewportWidth,
  contentTestID,
  showDivider = false,
}: {
  rows: SplitDiffRow[];
  side: "left" | "right";
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  startRowIndex: number;
  minContentWidth: number;
  textViewportWidth: number;
  contentTestID: string;
  showDivider?: boolean;
}) {
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
    () => [
      styles.linesContainer,
      inlineUnistylesStyle({ minWidth: Math.max(textViewportWidth, minContentWidth) }),
    ],
    [minContentWidth, textViewportWidth],
  );
  const headerLineTextStyle = useMemo(
    () => [styles.diffTextMetrics, textMetricsStyle, styles.diffLineText, styles.headerLineText],
    [textMetricsStyle],
  );

  const keyedRows = useMemo(
    () => rows.map((row, index) => ({ key: `row-${startRowIndex + index}`, row })),
    [rows, startRowIndex],
  );

  if (wrapLines) {
    return (
      <View style={wrapCellStyle}>
        <View style={styles.linesContainer}>
          {keyedRows.map(({ key, row }) => {
            if (row.kind === "header") {
              return (
                <View key={key} style={styles.splitHeaderRow}>
                  <Text style={headerLineTextStyle}>{row.content}</Text>
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
                  textMetricsStyle={textMetricsStyle}
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
              <DiffGutterCell
                key={key}
                lineNumber={null}
                type="header"
                gutterWidth={gutterWidth}
                textMetricsStyle={textMetricsStyle}
              />
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
                textMetricsStyle={textMetricsStyle}
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
      <DiffHorizontalContent
        viewportStyle={styles.splitColumnScroll}
        contentStyle={[styles.diffContentInner, linesContainerRowStyle]}
        testID={contentTestID}
      >
        {keyedRows.map(({ key, row }) => {
          if (row.kind === "header") {
            return (
              <View key={key} style={styles.splitHeaderRow}>
                <Text style={headerLineTextStyle}>{row.content}</Text>
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
                textMetricsStyle={textMetricsStyle}
                reviewActions={reviewActions}
                hoverTargetKey={reviewTargetKey}
                onHoverTargetChange={setHoveredReviewTargetKey}
              />
              <InlineReviewThreadContent
                reviewTarget={line?.reviewTarget}
                reviewActions={reviewActions}
                reservedHeight={reviewRowState?.height}
                viewportWidth={textViewportWidth}
                pinToViewport
              />
            </View>
          );
        })}
      </DiffHorizontalContent>
    </View>
  );
}

function DiffFileActionsContextMenuContent({
  file,
  onOpenFile,
  onAddToChat,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDownload,
  onDuplicate,
  onRevert,
  testID,
}: Pick<
  DiffFileSectionProps,
  | "file"
  | "onOpenFile"
  | "onAddToChat"
  | "onCopyPath"
  | "onCopyRelativePath"
  | "onReveal"
  | "revealTargetName"
  | "onDownload"
  | "onDuplicate"
  | "onRevert"
  | "testID"
>) {
  const handleOpenFile = useCallback(() => onOpenFile?.(file.path), [file.path, onOpenFile]);
  const handleAddToChat = useCallback(() => onAddToChat?.(file.path), [file.path, onAddToChat]);
  const handleCopyPath = useCallback(() => onCopyPath?.(file.path), [file.path, onCopyPath]);
  const handleCopyRelativePath = useCallback(
    () => onCopyRelativePath?.(file.path),
    [file.path, onCopyRelativePath],
  );
  const handleReveal = useCallback(() => onReveal?.(file.path), [file.path, onReveal]);
  const handleDownload = useCallback(() => onDownload?.(file.path), [file.path, onDownload]);
  const handleDuplicate = useCallback(() => onDuplicate?.(file.path), [file.path, onDuplicate]);
  const handleRevert = useCallback(
    () => onRevert?.(file.path, file.oldPath),
    [file.oldPath, file.path, onRevert],
  );

  return (
    <FileActionsContextMenuContent
      fileKind="file"
      fileExists={!file.isDeleted}
      onOpenFile={onOpenFile ? handleOpenFile : undefined}
      onCopyPath={onCopyPath ? handleCopyPath : undefined}
      onCopyRelativePath={onCopyRelativePath ? handleCopyRelativePath : undefined}
      onReveal={onReveal ? handleReveal : undefined}
      revealTargetName={revealTargetName}
      onDownload={onDownload ? handleDownload : undefined}
      onAddToChat={onAddToChat ? handleAddToChat : undefined}
      onDuplicate={!file.isDeleted && onDuplicate ? handleDuplicate : undefined}
      onRevert={onRevert ? handleRevert : undefined}
      testIDPrefix={testID}
    />
  );
}

const DiffFileHeader = memo(function DiffFileHeader({
  file,
  workspaceFileDragScope,
  isExpanded,
  isSelected = false,
  depth = 0,
  showDir = true,
  interactive = true,
  onToggle,
  onSelect,
  onOpenFile,
  onAddToChat,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDownload,
  onDuplicate,
  onRevert,
  onHeaderHeightChange,
  testID,
}: DiffFileSectionProps) {
  const dragSourceRef = useWorkspaceFileDragSource({
    enabled: interactive,
    disabled: file.isDeleted,
    workspaceId: null,
    path: file.path,
    ...workspaceFileDragScope,
  });
  const layoutYRef = useRef<number | null>(null);
  const pressHandledRef = useRef(false);
  const pressInRef = useRef<{ ts: number; pageX: number; pageY: number } | null>(null);

  const handleSelect = useCallback(() => {
    if (interactive) {
      onSelect?.(file.path);
    }
  }, [file.path, interactive, onSelect]);

  const toggleExpanded = useCallback(() => {
    if (!interactive) {
      return;
    }
    const selection = isWeb ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }
    pressHandledRef.current = true;
    handleSelect();
    onToggle?.(file.path);
  }, [file.path, handleSelect, interactive, onToggle]);

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

  const handleLongPress = useCallback(() => {
    pressHandledRef.current = true;
    handleSelect();
  }, [handleSelect]);

  const handlePressOut = useCallback(
    (event: { nativeEvent: { pageX: number; pageY: number } }) => {
      if (
        interactive &&
        isNative &&
        !pressHandledRef.current &&
        layoutYRef.current === 0 &&
        pressInRef.current
      ) {
        const durationMs = Date.now() - pressInRef.current.ts;
        const dx = event.nativeEvent.pageX - pressInRef.current.pageX;
        const dy = event.nativeEvent.pageY - pressInRef.current.pageY;
        const distance = Math.hypot(dx, dy);
        if (durationMs <= 500 && distance <= 12) {
          toggleExpanded();
        }
      }
    },
    [interactive, toggleExpanded],
  );

  const containerStyle = useMemo(
    () => [styles.fileSectionHeaderContainer, isExpanded && styles.fileSectionHeaderExpanded],
    [isExpanded],
  );
  const accessibilityState = useMemo(
    () => ({ expanded: isExpanded, selected: isSelected }),
    [isExpanded, isSelected],
  );

  const headerPressableStyle = useCallback(
    (state: PressableStateCallbackType) =>
      depth > 0
        ? [
            fileHeaderPressableStyle(state, isSelected),
            inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) }),
          ]
        : fileHeaderPressableStyle(state, isSelected),
    [depth, isSelected],
  );

  const fileName = file.path.split("/").pop() ?? file.path;
  const headerContent = (
    <>
      <View
        ref={dragSourceRef}
        style={showDir ? styles.fileHeaderLeft : [styles.fileHeaderLeft, styles.fileHeaderLeftTree]}
      >
        {showDir ? null : <View style={styles.fileChevronSpacer} />}
        {showDir ? null : (
          <View style={styles.fileIcon}>
            <MaterialFileIcon fileName={fileName} size={WORKSPACE_TREE_ICON_SIZE} />
          </View>
        )}
        <Text style={styles.fileName} numberOfLines={1}>
          {fileName}
        </Text>
        {showDir ? (
          <Text style={styles.fileDir} numberOfLines={1}>
            {file.path.includes("/") ? ` ${file.path.slice(0, file.path.lastIndexOf("/"))}` : ""}
          </Text>
        ) : (
          // Flex spacer in tree mode (no dir suffix) so the New/Deleted badge
          // stays right-aligned next to the diff stats, as in the flat list.
          <View style={styles.fileDirSpacer} />
        )}
        {file.isNew && <FileChangeIcon change="added" />}
        {file.isDeleted && <FileChangeIcon change="deleted" />}
      </View>
      <View style={styles.fileHeaderRight}>
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          testID={testID ? `${testID}-stat` : undefined}
        />
      </View>
    </>
  );

  let trigger: ReactElement;
  if (!interactive) {
    trigger = (
      <View
        {...{
          onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
        }}
        style={headerPressableStyle({ hovered: false, pressed: false })}
      >
        {headerContent}
      </View>
    );
  } else {
    trigger = (
      <ContextMenuTrigger
        testID={testID ? `${testID}-toggle` : undefined}
        style={headerPressableStyle}
        // Android: prevent parent pan/scroll gestures from canceling the tap release.
        cancelable={false}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onLongPress={handleLongPress}
        onContextMenu={handleSelect}
        onPress={toggleExpanded}
        accessibilityState={accessibilityState}
        aria-selected={isSelected}
      >
        {headerContent}
      </ContextMenuTrigger>
    );
  }

  return (
    <View style={containerStyle} onLayout={handleLayout} testID={testID}>
      <TreeIndentGuides depth={depth} />
      <ContextMenu>
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom" align="start" offset={6} maxWidth={520}>
            <Text style={styles.tooltipText}>{file.path}</Text>
          </TooltipContent>
        </Tooltip>
        {interactive ? (
          <DiffFileActionsContextMenuContent
            file={file}
            onOpenFile={onOpenFile}
            onAddToChat={onAddToChat}
            onCopyPath={onCopyPath}
            onCopyRelativePath={onCopyRelativePath}
            onReveal={onReveal}
            revealTargetName={revealTargetName}
            onDownload={onDownload}
            onDuplicate={onDuplicate}
            onRevert={onRevert}
            testID={testID}
          />
        ) : null}
      </ContextMenu>
    </View>
  );
});

function maxLineNumber(file: ParsedDiffFile): number {
  let maximum = 0;
  for (const hunk of file.hunks) {
    maximum = Math.max(maximum, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
  }
  return maximum;
}

function DiffFileStatus({ file }: { file: ParsedDiffFile }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.fileSectionBodyContainer, styles.fileSectionBorder]}>
      <View style={[styles.diffContent, styles.statusMessageContainer]}>
        <Text style={styles.statusMessageText}>
          {file.status === "binary"
            ? t("workspace.git.diff.binaryFile")
            : t("workspace.git.diff.tooLarge")}
        </Text>
      </View>
    </View>
  );
}

interface DiffRowGroupProps {
  item: UnifiedRowGroupItem | SplitRowGroupItem;
  viewportWidth: number;
  wrapLines: boolean;
  codeFontSize: number;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  onHeightChange?: (key: string, height: number) => void;
}

function DiffRowGroupView({
  item,
  viewportWidth,
  wrapLines,
  codeFontSize,
  textMetricsStyle,
  reviewActions,
  onHeightChange,
}: DiffRowGroupProps) {
  const [hoveredReviewTargetKey, setHoveredReviewTargetKey] = useState<string | null>(null);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (wrapLines) {
        onHeightChange?.(item.key, event.nativeEvent.layout.height);
      }
    },
    [item.key, onHeightChange, wrapLines],
  );

  const minimumContentWidth = Math.ceil(item.contentColumns * codeFontSize * 0.75 + SPACING[4]);
  const gutterWidth = lineNumberGutterWidth(maxLineNumber(item.file), codeFontSize);
  const textViewportWidth = Math.max(0, viewportWidth - gutterWidth);
  const minimumTextWidth = Math.max(textViewportWidth, minimumContentWidth);
  const linesContainerRowStyle = useMemo(
    () => [styles.linesContainer, inlineUnistylesStyle({ minWidth: minimumTextWidth })],
    [minimumTextWidth],
  );
  const groupStyle = useMemo(
    () => [
      styles.fileSectionBodyContainer,
      item.isLast && styles.fileSectionBorder,
      item.isFirst && styles.diffContent,
      styles.diffGroupContent,
    ],
    [item.isFirst, item.isLast],
  );

  if (item.type === "split_group") {
    return (
      <View
        style={[groupStyle, styles.splitRow]}
        onLayout={handleLayout}
        dataSet={CODE_SURFACE_DATASET}
        testID={`diff-file-${item.fileIndex}-group-${item.groupIndex}`}
      >
        <SplitDiffColumn
          rows={item.rows}
          side="left"
          gutterWidth={gutterWidth}
          wrapLines={wrapLines}
          textMetricsStyle={textMetricsStyle}
          reviewActions={reviewActions}
          startRowIndex={item.startRowIndex}
          minContentWidth={minimumContentWidth}
          textViewportWidth={Math.max(0, viewportWidth / 2 - gutterWidth)}
          contentTestID={`diff-file-${item.fileIndex}-group-${item.groupIndex}-left-content`}
        />
        <SplitDiffColumn
          rows={item.rows}
          side="right"
          gutterWidth={gutterWidth}
          wrapLines={wrapLines}
          textMetricsStyle={textMetricsStyle}
          reviewActions={reviewActions}
          startRowIndex={item.startRowIndex}
          minContentWidth={minimumContentWidth}
          textViewportWidth={Math.max(0, viewportWidth / 2 - gutterWidth)}
          contentTestID={`diff-file-${item.fileIndex}-group-${item.groupIndex}-right-content`}
          showDivider
        />
      </View>
    );
  }

  if (wrapLines) {
    return (
      <View
        style={groupStyle}
        onLayout={handleLayout}
        dataSet={CODE_SURFACE_DATASET}
        testID={`diff-file-${item.fileIndex}-group-${item.groupIndex}`}
      >
        <View style={styles.linesContainer}>
          {item.lines.map(({ line, lineNumber, key, reviewTarget }, localIndex) => {
            const index = item.startRowIndex + localIndex;
            return (
              <View key={key} testID={`diff-wrapped-row-${index}`}>
                <DiffLineView
                  line={line}
                  lineNumber={lineNumber}
                  gutterWidth={gutterWidth}
                  wrapLines
                  textMetricsStyle={textMetricsStyle}
                  reviewTarget={reviewTarget}
                  reviewActions={reviewActions}
                />
                <InlineReviewRow
                  reviewTarget={reviewTarget}
                  reviewActions={reviewActions}
                  gutterWidth={gutterWidth}
                />
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View
      style={[groupStyle, styles.diffContentRow]}
      onLayout={handleLayout}
      dataSet={CODE_SURFACE_DATASET}
      testID={`diff-file-${item.fileIndex}-group-${item.groupIndex}`}
    >
      <View style={styles.gutterColumn}>
        {item.lines.map(({ line, lineNumber, key, reviewTarget }, localIndex) => {
          const index = item.startRowIndex + localIndex;
          const hasReviewThread =
            getInlineReviewThreadState({ reviewTarget, reviewActions }) !== null;
          return (
            <Fragment key={key}>
              <DiffGutterCell
                lineNumber={lineNumber}
                type={line.type}
                gutterWidth={gutterWidth}
                textMetricsStyle={textMetricsStyle}
                reviewTarget={reviewTarget}
                reviewActions={reviewActions}
                isLineHovered={
                  reviewTarget?.key !== undefined && hoveredReviewTargetKey === reviewTarget.key
                }
                textTestID={`diff-gutter-text-${index}`}
                actionTestID={`diff-gutter-action-${index}`}
                rowTestID={`diff-gutter-row-${index}`}
              />
              {hasReviewThread ? (
                <InlineReviewGutterSpacer
                  reviewTarget={reviewTarget}
                  reviewActions={reviewActions}
                  gutterWidth={gutterWidth}
                />
              ) : null}
            </Fragment>
          );
        })}
      </View>
      <DiffHorizontalContent
        viewportStyle={styles.splitColumnScroll}
        contentStyle={[styles.diffContentInner, linesContainerRowStyle]}
        testID={`diff-file-${item.fileIndex}-group-${item.groupIndex}-content`}
      >
        {item.lines.map(({ line, key, reviewTarget }, localIndex) => {
          const index = item.startRowIndex + localIndex;
          const hasReviewThread =
            getInlineReviewThreadState({ reviewTarget, reviewActions }) !== null;
          return (
            <Fragment key={key}>
              <DiffTextLine
                line={line}
                wrapLines={false}
                textMetricsStyle={textMetricsStyle}
                reviewTarget={reviewTarget}
                reviewActions={reviewActions}
                hoverTargetKey={reviewTarget?.key ?? null}
                onHoverTargetChange={setHoveredReviewTargetKey}
                textTestID={`diff-code-text-${index}`}
                rowTestID={`diff-code-row-${index}`}
              />
              {hasReviewThread ? (
                <InlineReviewThreadContent
                  reviewTarget={reviewTarget}
                  reviewActions={reviewActions}
                  viewportWidth={textViewportWidth}
                  pinToViewport
                />
              ) : null}
            </Fragment>
          );
        })}
      </DiffHorizontalContent>
    </View>
  );
}

function areDiffRowGroupPropsEqual(previous: DiffRowGroupProps, next: DiffRowGroupProps): boolean {
  // Row arrays are rebuilt with the index. File identity pins cached row content, while the
  // geometry key and compared grouping inputs pin group membership.
  return (
    previous.item.key === next.item.key &&
    previous.item.type === next.item.type &&
    previous.item.file === next.item.file &&
    previous.item.fileIndex === next.item.fileIndex &&
    previous.item.depth === next.item.depth &&
    previous.item.groupIndex === next.item.groupIndex &&
    previous.item.startRowIndex === next.item.startRowIndex &&
    previous.item.isFirst === next.item.isFirst &&
    previous.item.isLast === next.item.isLast &&
    previous.item.contentColumns === next.item.contentColumns &&
    previous.viewportWidth === next.viewportWidth &&
    previous.wrapLines === next.wrapLines &&
    previous.codeFontSize === next.codeFontSize &&
    previous.textMetricsStyle === next.textMetricsStyle &&
    previous.reviewActions === next.reviewActions &&
    previous.onHeightChange === next.onHeightChange
  );
}

const DiffRowGroup = memo(DiffRowGroupView, areDiffRowGroupPropsEqual);

interface GitDiffPaneProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  enabled?: boolean;
  onOpenFile?: (path: string) => void;
  onAddToChat?: (path: string) => void;
}

type PressableStyleFn = (
  state: PressableStateCallbackType & { hovered?: boolean; open?: boolean },
) => StyleProp<ViewStyle>;

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedAlignJustify = withUnistyles(AlignJustify);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedPilcrow = withUnistyles(Pilcrow);
const ThemedWrapText = withUnistyles(WrapText);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedList = withUnistyles(List);
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedChevronDown = withUnistyles(ChevronDown);
const DIFF_OPTIONS_WHITESPACE_ICON = (
  <ThemedPilcrow size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_WRAP_ICON = (
  <ThemedWrapText size={14} uniProps={foregroundMutedIconColorMapping} />
);

interface DiffLayoutToggleProps {
  layout: "unified" | "split";
  isMobile: boolean;
  testID?: string;
  toggleStyle?: PressableStyleFn;
  onToggle: () => void;
}

export function DiffLayoutToggle({
  layout,
  isMobile,
  testID = "changes-toggle-layout",
  toggleStyle,
  onToggle,
}: DiffLayoutToggleProps) {
  const defaultToggleStyle = useMemo(
    () => buildToggleButtonStyle(false, styles.expandAllButton),
    [],
  );
  const { t } = useTranslation();
  const label =
    layout === "unified"
      ? t("workspace.git.diff.switchToSplit")
      : t("workspace.git.diff.switchToUnified");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
          onPress={onToggle}
          style={toggleStyle ?? defaultToggleStyle}
        >
          {layout === "unified" ? (
            <ThemedColumns2 size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          ) : (
            <ThemedAlignJustify
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface ChangesTabToggleProps {
  isMobile: boolean;
  selected: boolean;
  onPress: () => void;
}

interface DiffModeMenuProps {
  diffMode: "uncommitted" | "base";
  committedDescription?: string;
  testIDPrefix?: string;
  onSelectUncommitted: () => void;
  onSelectBase: () => void;
}

export function DiffModeMenu({
  diffMode,
  committedDescription,
  testIDPrefix = "changes-diff",
  onSelectUncommitted,
  onSelectBase,
}: DiffModeMenuProps) {
  const { t } = useTranslation();
  const triggerStyle = useMemo(() => buildDiffModeTriggerStyle(), []);
  const uncommittedLabel = t("workspace.git.diff.uncommitted");
  const committedLabel = t("workspace.git.diff.committed");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID={`${testIDPrefix}-status-trigger`}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.git.diff.diffMode")}
      >
        <Text style={styles.diffStatusText} numberOfLines={1}>
          {diffMode === "uncommitted" ? uncommittedLabel : committedLabel}
        </Text>
        <ThemedChevronDown size={12} uniProps={foregroundMutedIconColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={260} testID={`${testIDPrefix}-status-menu`}>
        <DropdownMenuItem
          testID={`${testIDPrefix}-mode-uncommitted`}
          selected={diffMode === "uncommitted"}
          onSelect={onSelectUncommitted}
        >
          {uncommittedLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID={`${testIDPrefix}-mode-committed`}
          selected={diffMode === "base"}
          description={committedDescription}
          onSelect={onSelectBase}
        >
          {committedLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangesTabToggle({ isMobile, selected, onPress }: ChangesTabToggleProps) {
  const { t } = useTranslation();
  const buttonStyle = useMemo(
    () => buildToggleButtonStyle(selected, styles.expandAllButton),
    [selected],
  );
  const label = t(
    selected ? "workspace.git.diff.closeChangesTab" : "workspace.git.diff.openChangesTab",
  );
  if (isMobile) {
    return null;
  }
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="changes-open-tab"
          onPress={onPress}
          style={buttonStyle}
        >
          <ThemedMaximize2 size={14} uniProps={foregroundMutedIconColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffViewModeToggleProps {
  viewMode: "flat" | "tree";
  isMobile: boolean;
  toggleStyle: PressableStyleFn;
  onToggle: () => void;
}

function DiffViewModeToggle({
  viewMode,
  isMobile,
  toggleStyle,
  onToggle,
}: DiffViewModeToggleProps) {
  const { t } = useTranslation();
  const label =
    viewMode === "flat"
      ? t("workspace.git.diff.showTreeView")
      : t("workspace.git.diff.showFlatView");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="changes-toggle-view-mode"
          style={toggleStyle}
          onPress={onToggle}
        >
          {viewMode === "flat" ? (
            <ThemedFolderTree
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          ) : (
            <ThemedList size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffFilesToolbarProps {
  allFileDiffsExpanded: boolean;
  isMobile: boolean;
  testID?: string;
  expandAllToggleStyle?: PressableStyleFn;
  onToggleExpandAll: () => void;
}

export function DiffFilesToolbar({
  allFileDiffsExpanded,
  isMobile,
  testID,
  expandAllToggleStyle,
  onToggleExpandAll,
}: DiffFilesToolbarProps) {
  const defaultToggleStyle = useMemo(() => buildExpandAllButtonStyle(), []);
  const { t } = useTranslation();
  const expandAllLabel = allFileDiffsExpanded
    ? t("workspace.git.diff.collapseAll")
    : t("workspace.git.diff.expandAll");
  return (
    <View style={styles.diffStatusButtons}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expandAllLabel}
            testID={testID}
            style={expandAllToggleStyle ?? defaultToggleStyle}
            onPress={onToggleExpandAll}
          >
            {allFileDiffsExpanded ? (
              <ThemedListChevronsDownUp
                size={isMobile ? 18 : 14}
                uniProps={foregroundMutedIconColorMapping}
              />
            ) : (
              <ThemedListChevronsUpDown
                size={isMobile ? 18 : 14}
                uniProps={foregroundMutedIconColorMapping}
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{expandAllLabel}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

interface DiffOptionsMenuProps {
  brand?: string;
  hideWhitespace: boolean;
  isMobile: boolean;
  isRefreshing?: boolean;
  overflowToggleStyle?: PressableStyleFn;
  refreshSupported?: boolean;
  testIDPrefix?: string;
  wrapLines: boolean;
  onRefresh?: () => void;
  onToggleHideWhitespace: () => void;
  onToggleWrapLines: () => void;
}

export function DiffOptionsMenu({
  brand,
  hideWhitespace,
  isMobile,
  isRefreshing = false,
  overflowToggleStyle,
  refreshSupported = false,
  testIDPrefix = "changes",
  wrapLines,
  onRefresh,
  onToggleHideWhitespace,
  onToggleWrapLines,
}: DiffOptionsMenuProps) {
  const { t } = useTranslation();
  const defaultToggleStyle = useMemo(() => buildOverflowButtonStyle(), []);
  const whitespaceLabel = hideWhitespace
    ? t("workspace.git.diff.showWhitespace")
    : t("workspace.git.diff.hideWhitespace");
  const wrapLinesLabel = wrapLines
    ? t("workspace.git.diff.scrollLongLines")
    : t("workspace.git.diff.wrapLongLines");
  const optionsLabel = t("workspace.git.diff.options");
  let refreshLabel = t("workspace.git.diff.refresh");
  if (isRefreshing) {
    refreshLabel = t("workspace.git.diff.refreshing");
  } else if (brand) {
    refreshLabel = t("workspace.git.diff.refreshState", { brand });
  }
  const refreshIcon = useMemo(
    () =>
      isRefreshing ? (
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ) : (
        <ThemedRotateCw size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ),
    [isRefreshing],
  );

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={optionsLabel}
            testID={`${testIDPrefix}-options-menu`}
            style={overflowToggleStyle ?? defaultToggleStyle}
          >
            <ThemedChevronDown
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{optionsLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" width={240} testID={`${testIDPrefix}-options-menu-content`}>
        <DropdownMenuItem
          leading={DIFF_OPTIONS_WHITESPACE_ICON}
          selected={hideWhitespace}
          testID={`${testIDPrefix}-toggle-whitespace`}
          onSelect={onToggleHideWhitespace}
        >
          {whitespaceLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={DIFF_OPTIONS_WRAP_ICON}
          selected={wrapLines}
          testID={`${testIDPrefix}-toggle-wrap-lines`}
          onSelect={onToggleWrapLines}
        >
          {wrapLinesLabel}
        </DropdownMenuItem>
        {refreshSupported && onRefresh ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              leading={refreshIcon}
              disabled={isRefreshing}
              testID={`${testIDPrefix}-refresh`}
              onSelect={onRefresh}
            >
              {refreshLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);

type DiffListItemLayoutGetter = NonNullable<FlatListProps<DiffListItem>["getItemLayout"]>;

// COMPAT(react-native-virtualized-list-bounded-data-growth): RN 0.81 carries the old index range
// through middle insertions, synchronously mounting every inserted diff group in that range.
const BOUNDED_DIFF_LIST_DATA_GROWTH_PROPS = {
  unstable_boundedRangeOnDataChange: true,
} as const;
const EMPTY_PATH_LIST: string[] = [];
const EMPTY_NUMBER_LIST: number[] = [];

function computeEmptyMessage(
  hideWhitespace: boolean,
  diffMode: "uncommitted" | "base",
  baseRefLabel: string,
  labels: {
    hiddenWhitespace: string;
    uncommitted: string;
    againstBase: (baseRefLabel: string) => string;
  },
): string {
  if (hideWhitespace) {
    return labels.hiddenWhitespace;
  }
  if (diffMode === "uncommitted") {
    return labels.uncommitted;
  }
  return labels.againstBase(baseRefLabel);
}

interface DiffBodyContentProps {
  isStatusLoading: boolean;
  statusErrorMessage: string | null;
  notGit: boolean;
  isDiffLoading: boolean;
  diffErrorMessage: string | null;
  diffTooLarge: boolean;
  hasChanges: boolean;
  emptyMessage: string;
  children: ReactElement;
  checkingRepositoryLabel: string;
  notRepositoryLabel: string;
}

function DiffBodyContent({
  isStatusLoading,
  statusErrorMessage,
  notGit,
  isDiffLoading,
  diffErrorMessage,
  diffTooLarge,
  hasChanges,
  emptyMessage,
  children,
  checkingRepositoryLabel,
  notRepositoryLabel,
}: DiffBodyContentProps) {
  if (isStatusLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
        <Text style={styles.loadingText}>{checkingRepositoryLabel}</Text>
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
        <Text style={styles.emptyText}>{notRepositoryLabel}</Text>
      </View>
    );
  }
  if (isDiffLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }
  if (diffTooLarge) {
    return <DiffTooLargeState />;
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
  return children;
}

interface SharedDiffViewProps {
  files: ParsedDiffFile[];
  displayPreferences: {
    layout: "unified" | "split";
    wrapLines: boolean;
    codeFontSize: number;
    monoFontFamily: string;
  };
  mode:
    | {
        kind: "working_tree";
        viewMode: "flat" | "tree";
        expandedPaths: string[];
        collapsedFolders: string[];
        reviewActions?: InlineReviewActions;
        onFilePress?: (path: string) => void;
        workspaceFileDragScope?: { serverId: string; workspaceId: string };
        onOpenFile?: (path: string) => void;
        onAddToChat?: (path: string) => void;
        onCopyPath?: (path: string) => void;
        onCopyRelativePath?: (path: string) => void;
        onReveal?: (path: string) => void;
        revealTargetName?: string;
        onDownload?: (path: string) => void;
        onDuplicate?: (path: string) => void;
        onRevert?: (path: string, oldPath?: string) => void;
        onExpandedPathsChange: (paths: string[]) => void;
        onCollapsedFoldersChange: (paths: string[]) => void;
      }
    | {
        kind: "working_tab";
        expandedPaths: string[] | null;
        reviewActions: InlineReviewActions;
        focusPath?: string;
        focusRequestId?: number;
        onExpandedPathsChange: (paths: string[]) => void;
      }
    | {
        kind: "commit";
      };
}

type WorkingTreeDiffMode = Extract<SharedDiffViewProps["mode"], { kind: "working_tree" }>;
const EMPTY_WORKING_TREE_DIFF_MODE: Partial<WorkingTreeDiffMode> = {};

export function SharedDiffView({ files, displayPreferences, mode }: SharedDiffViewProps) {
  const isCompact = useIsCompactFormFactor();
  const { layout, wrapLines, codeFontSize, monoFontFamily } = displayPreferences;
  const diffBodyLineHeight = Math.round(codeFontSize * 1.5);
  const typographyKey = [monoFontFamily, codeFontSize, diffBodyLineHeight].join(":");
  const textMetricsStyle = useMemo<TextStyle>(() => {
    const trimmedMonoFontFamily = monoFontFamily.trim();
    return {
      fontSize: codeFontSize,
      lineHeight: diffBodyLineHeight,
      ...(trimmedMonoFontFamily ? { fontFamily: trimmedMonoFontFamily } : null),
    };
  }, [codeFontSize, diffBodyLineHeight, monoFontFamily]);
  const workingTreeMode = mode.kind === "working_tree" ? mode : EMPTY_WORKING_TREE_DIFF_MODE;
  const {
    viewMode = "flat",
    collapsedFolders: collapsedFoldersArray = EMPTY_PATH_LIST,
    onFilePress,
    onOpenFile,
    onAddToChat,
    workspaceFileDragScope,
    onCopyPath,
    onCopyRelativePath,
    onReveal,
    revealTargetName,
    onDownload,
    onDuplicate,
    onRevert,
  } = workingTreeMode;
  const expandedPathsArray = useMemo(() => {
    if (mode.kind === "working_tree") {
      return mode.expandedPaths;
    }
    if (mode.kind === "working_tab" && mode.expandedPaths !== null) {
      return mode.expandedPaths;
    }
    return files.map((file) => file.path);
  }, [files, mode]);
  const expandedPaths = useMemo(() => new Set(expandedPathsArray), [expandedPathsArray]);
  const collapsedFolders = useMemo(() => new Set(collapsedFoldersArray), [collapsedFoldersArray]);
  const stickyHeaders = mode.kind !== "commit";
  const interactive = mode.kind !== "commit";
  const reviewActions = mode.kind === "commit" ? undefined : mode.reviewActions;
  const focusPath = mode.kind === "working_tab" ? mode.focusPath : undefined;
  const focusRequestId = mode.kind === "working_tab" ? mode.focusRequestId : undefined;
  // Keep selection independent from expansion so future keyboard actions (such as R to rename)
  // can target the current VCS file or folder without changing its open state.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const handleSelectPath = useCallback((path: string) => setSelectedPath(path), []);
  const compressedTree = useMemo(() => compressSingleChildChains(buildDiffTree(files)), [files]);
  const allFolderPaths = useMemo(() => collectDirPaths(compressedTree), [compressedTree]);
  const allFolderPathSet = useMemo(() => new Set(allFolderPaths), [allFolderPaths]);
  useEffect(() => {
    if (
      selectedPath &&
      !allFolderPathSet.has(selectedPath) &&
      !files.some((file) => file.path === selectedPath)
    ) {
      setSelectedPath(null);
    }
  }, [allFolderPathSet, files, selectedPath]);
  const effectiveCollapsedFolders = useMemo(
    () => new Set(Array.from(collapsedFolders).filter((path) => allFolderPathSet.has(path))),
    [allFolderPathSet, collapsedFolders],
  );
  const diffListRef = useRef<FlatList<DiffListItem>>(null);
  const scrollbar = useOverlayFlatListScrollbar(diffListRef, { enabled: !isCompact });
  const { onLayout: updateScrollbarLayout, onScroll: updateScrollbarOffset } = scrollbar;
  const consumedFocusRequestRef = useRef<string | null>(null);
  const pendingFocusRequestRef = useRef<string | null>(null);
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const pendingMeasuredHeightCorrectionRef = useRef(0);
  const [diffListWidth, setDiffListWidth] = useState(800);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const measuredGroupHeightsRef = useRef(new Map<string, number>());
  const rowCacheRef = useRef(createDiffRowCache());
  const folderRowHeightRef = useRef<number>(0);
  const defaultHeaderHeightRef = useRef<number>(44);
  const [heightVersion, setHeightVersion] = useState(0);
  const [geometryVersion, setGeometryVersion] = useState(0);
  const heightVersionFrameRef = useRef<number | null>(null);
  const geometryVersionFrameRef = useRef<number | null>(null);
  const scheduleHeightVersionUpdate = useCallback(() => {
    if (heightVersionFrameRef.current !== null) {
      return;
    }
    heightVersionFrameRef.current = requestAnimationFrame(() => {
      heightVersionFrameRef.current = null;
      setHeightVersion((version) => version + 1);
    });
  }, []);
  const scheduleGeometryVersionUpdate = useCallback(() => {
    if (geometryVersionFrameRef.current !== null) {
      return;
    }
    geometryVersionFrameRef.current = requestAnimationFrame(() => {
      geometryVersionFrameRef.current = null;
      setGeometryVersion((version) => version + 1);
    });
  }, []);
  useEffect(
    () => () => {
      if (heightVersionFrameRef.current !== null) {
        cancelAnimationFrame(heightVersionFrameRef.current);
      }
      if (geometryVersionFrameRef.current !== null) {
        cancelAnimationFrame(geometryVersionFrameRef.current);
      }
    },
    [],
  );
  const diffBodyChromeHeight = BORDER_WIDTH[1] * 2;
  const statusBodyHeightEstimate = diffBodyChromeHeight + SPACING[4] * 2 + diffBodyLineHeight;

  const reviewHeightFor = useCallback(
    (target: ReviewableDiffTarget | null | undefined): number =>
      getInlineReviewThreadState({ reviewTarget: target, reviewActions })?.height ?? 0,
    [reviewActions],
  );
  const geometryKey = `${layout}:${wrapLines ? "wrap" : "scroll"}:${typographyKey}:${Math.round(diffListWidth)}`;
  const rowIndex = useMemo(() => {
    void heightVersion;
    return buildDiffRowIndex({
      files,
      viewMode,
      tree: compressedTree,
      collapsedFolders: effectiveCollapsedFolders,
      expandedPaths,
      layout,
      wrapLines,
      lineHeight: diffBodyLineHeight,
      viewportWidth: diffListWidth,
      codeFontSize,
      headerHeightFor: (file) =>
        headerHeightByPathRef.current[file.path] ?? defaultHeaderHeightRef.current,
      folderHeight: folderRowHeightRef.current || defaultHeaderHeightRef.current,
      statusHeight: statusBodyHeightEstimate,
      measuredGroupHeights: measuredGroupHeightsRef.current,
      geometryKey,
      reviewHeightFor,
      rowCache: rowCacheRef.current,
    });
  }, [
    codeFontSize,
    compressedTree,
    diffBodyLineHeight,
    diffListWidth,
    effectiveCollapsedFolders,
    expandedPaths,
    files,
    geometryKey,
    heightVersion,
    layout,
    reviewHeightFor,
    statusBodyHeightEstimate,
    viewMode,
    wrapLines,
  ]);
  const flatItems = rowIndex.items;
  const horizontalContentColumns = useMemo(
    () =>
      flatItems.reduce(
        (maximum, item) =>
          item.type === "unified_group" || item.type === "split_group"
            ? Math.max(maximum, item.contentColumns)
            : maximum,
        0,
      ),
    [flatItems],
  );
  const maximumGutterWidth = useMemo(
    () =>
      files.reduce(
        (maximum, file) =>
          Math.max(maximum, lineNumberGutterWidth(maxLineNumber(file), codeFontSize)),
        0,
      ),
    [codeFontSize, files],
  );
  const horizontalCodeWidth = Math.ceil(
    horizontalContentColumns * codeFontSize * 0.75 + SPACING[4],
  );
  const horizontalCodeViewportWidth = Math.max(
    0,
    (layout === "split" ? diffListWidth / 2 : diffListWidth) - maximumGutterWidth,
  );
  const horizontalSurfaceWidth =
    diffListWidth + Math.max(0, horizontalCodeWidth - horizontalCodeViewportWidth);
  const rowIndexRef = useRef(rowIndex);
  rowIndexRef.current = rowIndex;
  const stickyHeaderIndices = stickyHeaders ? rowIndex.stickyHeaderIndices : EMPTY_NUMBER_LIST;

  const handleFolderRowHeightChange = useCallback(
    (height: number) => {
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      const previousHeight = folderRowHeightRef.current;
      if (previousHeight > 0 && Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON) {
        return;
      }
      folderRowHeightRef.current = height;
      scheduleHeightVersionUpdate();
    },
    [scheduleHeightVersionUpdate],
  );

  const handleHeaderHeightChange = useCallback(
    (path: string, height: number) => {
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
      scheduleHeightVersionUpdate();
    },
    [scheduleHeightVersionUpdate],
  );

  const handleGroupHeightChange = useCallback(
    (key: string, height: number) => {
      if (!Number.isFinite(height) || height < 0) {
        return;
      }
      const previousHeight = measuredGroupHeightsRef.current.get(key);
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
      ) {
        return;
      }
      const currentIndex = rowIndexRef.current;
      const update = currentIndex.updateHeight(key, height);
      if (!update) return;
      if (
        currentIndex.offsetAt(update.index) + update.previousHeight <=
        diffListScrollOffsetRef.current
      ) {
        pendingMeasuredHeightCorrectionRef.current += update.delta;
      }
      measuredGroupHeightsRef.current.set(key, height);
      scheduleGeometryVersionUpdate();
    },
    [scheduleGeometryVersionUpdate],
  );

  useEffect(() => {
    const correction = pendingMeasuredHeightCorrectionRef.current;
    if (correction === 0) {
      return;
    }
    pendingMeasuredHeightCorrectionRef.current = 0;
    const offset = Math.max(0, diffListScrollOffsetRef.current + correction);
    diffListScrollOffsetRef.current = offset;
    diffListRef.current?.scrollToOffset({ offset, animated: false });
  }, [geometryVersion]);

  const handleDiffListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y;
      diffListScrollOffsetRef.current = offset;
      updateScrollbarOffset(event);
    },
    [updateScrollbarOffset],
  );

  const handleDiffListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      setDiffListWidth(event.nativeEvent.layout.width);
      diffListViewportHeightRef.current = height;
      updateScrollbarLayout(event);
    },
    [updateScrollbarLayout],
  );

  const computeItemOffset = useCallback(
    (predicate: (item: DiffListItem) => boolean): number | null => {
      const index = flatItems.findIndex(predicate);
      if (index < 0) {
        return null;
      }
      return rowIndex.offsetAt(index);
    },
    [flatItems, rowIndex],
  );

  const computeHeaderOffset = useCallback(
    (path: string): number => rowIndex.offsetOfFile(path),
    [rowIndex],
  );

  useEffect(() => {
    if (!focusPath) {
      return;
    }
    const focusRequestKey = `${focusRequestId ?? "initial"}:${focusPath}`;
    if (
      consumedFocusRequestRef.current === focusRequestKey ||
      pendingFocusRequestRef.current === focusRequestKey
    ) {
      return;
    }
    const hasTarget = flatItems.some(
      (item) => item.type === "header" && item.file.path === focusPath,
    );
    if (!hasTarget) {
      return;
    }
    pendingFocusRequestRef.current = focusRequestKey;
    const frame = requestAnimationFrame(() => {
      diffListRef.current?.scrollToOffset({
        offset: computeHeaderOffset(focusPath),
        animated: false,
      });
      consumedFocusRequestRef.current = focusRequestKey;
      pendingFocusRequestRef.current = null;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (pendingFocusRequestRef.current === focusRequestKey) {
        pendingFocusRequestRef.current = null;
      }
    };
  }, [computeHeaderOffset, flatItems, focusPath, focusRequestId]);

  const handleToggleExpanded = useCallback(
    (path: string) => {
      if (mode.kind === "commit") {
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

      if (shouldAnchor && targetOffset !== null) {
        diffListRef.current?.scrollToOffset({
          offset: targetOffset,
          animated: false,
        });
      }

      mode.onExpandedPathsChange(
        nextExpanded
          ? [...expandedPaths, path]
          : Array.from(expandedPaths).filter((expandedPath) => expandedPath !== path),
      );
    },
    [computeHeaderOffset, expandedPaths, mode],
  );

  const handleToggleFolder = useCallback(
    (dirPath: string) => {
      if (mode.kind !== "working_tree") {
        return;
      }
      const isCurrentlyCollapsed = effectiveCollapsedFolders.has(dirPath);
      if (!isCurrentlyCollapsed) {
        const targetOffset = computeItemOffset(
          (item) => item.type === "folder" && item.dirPath === dirPath,
        );
        const folderHeight = folderRowHeightRef.current || defaultHeaderHeightRef.current;
        if (
          targetOffset !== null &&
          shouldAnchorHeaderBeforeCollapse({
            headerOffset: targetOffset,
            headerHeight: folderHeight,
            viewportOffset: diffListScrollOffsetRef.current,
            viewportHeight: diffListViewportHeightRef.current,
          })
        ) {
          diffListRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
        }
      }

      mode.onCollapsedFoldersChange(
        isCurrentlyCollapsed
          ? Array.from(effectiveCollapsedFolders).filter((path) => path !== dirPath)
          : [...effectiveCollapsedFolders, dirPath],
      );
    },
    [computeItemOffset, effectiveCollapsedFolders, mode],
  );

  const handleCollapseFolder = useCallback(
    (dirPath: string) => {
      if (mode.kind !== "working_tree") {
        return;
      }
      const targetOffset = computeItemOffset(
        (item) => item.type === "folder" && item.dirPath === dirPath,
      );
      const folderHeight = folderRowHeightRef.current || defaultHeaderHeightRef.current;
      if (
        targetOffset !== null &&
        shouldAnchorHeaderBeforeCollapse({
          headerOffset: targetOffset,
          headerHeight: folderHeight,
          viewportOffset: diffListScrollOffsetRef.current,
          viewportHeight: diffListViewportHeightRef.current,
        })
      ) {
        diffListRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
      }

      const pathPrefix = `${dirPath}/`;
      mode.onCollapsedFoldersChange([
        ...new Set([
          ...effectiveCollapsedFolders,
          ...allFolderPaths.filter(
            (folderPath) => folderPath === dirPath || folderPath.startsWith(pathPrefix),
          ),
        ]),
      ]);
    },
    [allFolderPaths, computeItemOffset, effectiveCollapsedFolders, mode],
  );

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffListItem }) => {
      if (item.type === "folder") {
        return (
          <DiffFolderRow
            dirPath={item.dirPath}
            displayName={item.displayName}
            depth={item.depth}
            collapsed={item.collapsed}
            isSelected={selectedPath === item.dirPath}
            additions={item.additions}
            deletions={item.deletions}
            onToggle={handleToggleFolder}
            onCollapse={handleCollapseFolder}
            onSelect={handleSelectPath}
            onHeightChange={handleFolderRowHeightChange}
            onCopyPath={onCopyPath}
            onCopyRelativePath={onCopyRelativePath}
            onReveal={onReveal}
            revealTargetName={revealTargetName}
            onDuplicate={onDuplicate}
            onRevert={onRevert}
            testID={`diff-folder-${item.dirPath}`}
          />
        );
      }
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            workspaceFileDragScope={workspaceFileDragScope}
            isExpanded={item.isExpanded}
            isSelected={selectedPath === item.file.path}
            depth={item.depth}
            showDir={viewMode === "flat"}
            interactive={interactive}
            onToggle={interactive ? (onFilePress ?? handleToggleExpanded) : undefined}
            onSelect={handleSelectPath}
            onOpenFile={onOpenFile}
            onAddToChat={onAddToChat}
            onCopyPath={onCopyPath}
            onCopyRelativePath={onCopyRelativePath}
            onReveal={onReveal}
            revealTargetName={revealTargetName}
            onDownload={onDownload}
            onDuplicate={onDuplicate}
            onRevert={onRevert}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-file-${item.fileIndex}`}
          />
        );
      }
      if (item.type === "status") {
        return <DiffFileStatus file={item.file} />;
      }
      return (
        <DiffRowGroup
          item={item}
          viewportWidth={diffListWidth}
          wrapLines={wrapLines}
          codeFontSize={codeFontSize}
          textMetricsStyle={textMetricsStyle}
          reviewActions={reviewActions}
          onHeightChange={handleGroupHeightChange}
        />
      );
    },
    [
      codeFontSize,
      diffListWidth,
      handleGroupHeightChange,
      handleFolderRowHeightChange,
      handleHeaderHeightChange,
      handleCollapseFolder,
      handleSelectPath,
      handleToggleExpanded,
      handleToggleFolder,
      reviewActions,
      workspaceFileDragScope,
      textMetricsStyle,
      viewMode,
      wrapLines,
      interactive,
      onFilePress,
      onOpenFile,
      onAddToChat,
      onCopyPath,
      onCopyRelativePath,
      onReveal,
      revealTargetName,
      onDownload,
      onDuplicate,
      onRevert,
      selectedPath,
    ],
  );

  const flatKeyExtractor = useCallback((item: DiffListItem) => {
    if (item.type === "folder") {
      return `folder-${item.dirPath}`;
    }
    if (item.type === "unified_group" || item.type === "split_group") {
      return item.key;
    }
    return `${item.type}-${item.file.path}`;
  }, []);

  const getFlatItemLayout = useCallback<DiffListItemLayoutGetter>(
    (_data, index) => {
      void geometryVersion;
      return {
        length: rowIndex.heightAt(index),
        offset: rowIndex.offsetAt(index),
        index,
      };
    },
    [geometryVersion, rowIndex],
  );

  const flatExtraData = useMemo(
    () => ({
      expandedPathsArray,
      collapsedFoldersArray,
      layout,
      typographyKey,
      heightVersion,
      geometryVersion,
      viewMode,
      wrapLines,
      reviewActions,
      workspaceFileDragScope,
    }),
    [
      expandedPathsArray,
      collapsedFoldersArray,
      heightVersion,
      geometryVersion,
      layout,
      reviewActions,
      typographyKey,
      viewMode,
      workspaceFileDragScope,
      wrapLines,
    ],
  );

  const diffList = (
    <FlatList
      {...BOUNDED_DIFF_LIST_DATA_GROWTH_PROPS}
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
      onContentSizeChange={scrollbar.onContentSizeChange}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={!scrollbar.enabled}
      removeClippedSubviews={false}
      initialNumToRender={DIFF_VIRTUALIZATION_CONFIG.initialNumToRender}
      maxToRenderPerBatch={DIFF_VIRTUALIZATION_CONFIG.maxToRenderPerBatch}
      updateCellsBatchingPeriod={DIFF_VIRTUALIZATION_CONFIG.updateCellsBatchingPeriod}
      windowSize={DIFF_VIRTUALIZATION_CONFIG.windowSize}
    />
  );

  return (
    <View style={styles.scrollContainer}>
      {wrapLines ? (
        diffList
      ) : (
        <DiffHorizontalSurface
          contentWidth={horizontalSurfaceWidth}
          viewportWidth={diffListWidth}
          onViewportWidthChange={setDiffListWidth}
        >
          {diffList}
        </DiffHorizontalSurface>
      )}
      {scrollbar.overlay}
    </View>
  );
}

function computeBaseRefLabel(baseRef: string | undefined, fallbackLabel: string): string {
  if (!baseRef) return fallbackLabel;
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

function computePrErrorMessage(
  githubFeaturesEnabled: boolean,
  prPayloadError: { message?: string } | null | undefined,
): string | null {
  if (!githubFeaturesEnabled) return null;
  return prPayloadError?.message ?? null;
}

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
type ForgeSetupAction = "install_cli" | "sign_in" | null;

// Drive the onboarding callout from the forge's auth state so the message names
// the exact next step (install the CLI vs sign in) for whichever forge backs the
// workspace — GitHub included. GitLab additionally requires the host to advertise
// GitLab support, matching the rest of the GitLab UI.
function computeForgeSetupAction(input: {
  forge: Forge;
  forgeProvidersSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupAction {
  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return null;
  }
  switch (input.authState) {
    case "cli_missing":
      return "install_cli";
    case "unauthenticated":
      return "sign_in";
    case "authenticated":
    case "no_remote":
    case "error":
      return null;
    default:
      return null;
  }
}

function parseForgeHost(url: string | null | undefined): string | null {
  return url ? (parseGitRemoteLocation(url)?.host ?? null) : null;
}

function buildForgeSetupMessage(input: {
  action: ForgeSetupAction;
  forge: Forge;
  host: string | null;
  t: TFunction;
}): string | null {
  if (!input.action) {
    return null;
  }
  const { brandLabel, signInCli } = getForgePresentation(input.forge);
  // A forge with no known CLI (an unknown/third-party forge rendered neutrally)
  // has no install/sign-in command to interpolate — show neutral guidance
  // rather than the GitLab-specific callout or a null command.
  if (signInCli === null) {
    return input.t("workspace.git.forgeSetup.generic", { brand: brandLabel });
  }
  if (input.action === "install_cli") {
    return input.t("workspace.git.forgeSetup.installCli", { cli: signInCli, brand: brandLabel });
  }
  const command = buildForgeSignInCommand(input.forge, input.host);
  return input.t("workspace.git.forgeSetup.signIn", { command, brand: brandLabel });
}

function buildDiffModeTriggerStyle(): PressableStyleFn {
  return ({ hovered, pressed, open }) => [
    styles.diffModeTrigger,
    (Boolean(hovered) || pressed || Boolean(open)) && styles.diffModeTriggerHovered,
  ];
}

function buildExpandAllButtonStyle(): PressableStyleFn {
  return ({ hovered, pressed }) => [
    styles.expandAllButton,
    (Boolean(hovered) || pressed) && styles.toggleButtonSelected,
  ];
}

function buildOverflowButtonStyle(): PressableStyleFn {
  return ({ hovered, pressed }) => [
    styles.overflowButton,
    (Boolean(hovered) || pressed) && styles.toggleButtonSelected,
  ];
}

function buildToggleButtonStyle(
  selected: boolean,
  baseStyles: StyleProp<ViewStyle> | StyleProp<ViewStyle>[],
): PressableStyleFn {
  return ({ hovered, pressed }) => [
    baseStyles,
    (selected || Boolean(hovered) || pressed) && styles.toggleButtonSelected,
  ];
}

function useChangesTreeState({
  workspaceId,
  cwd,
  files,
  viewMode,
  changesTabOpen,
  onViewModeChange,
}: {
  workspaceId?: string | null;
  cwd: string;
  files: ParsedDiffFile[];
  viewMode: "flat" | "tree";
  changesTabOpen: boolean;
  onViewModeChange: (viewMode: "flat" | "tree") => void;
}) {
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: cwd.trim(),
      }),
    [cwd, workspaceId],
  );
  const expandedPaths = usePanelStore((state) =>
    workspaceStateKey ? state.diffExpandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const collapsedFolders = usePanelStore((state) =>
    workspaceStateKey ? state.diffCollapsedFoldersByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPaths = usePanelStore((state) => state.setDiffExpandedPathsForWorkspace);
  const setCollapsedFolders = usePanelStore((state) => state.setDiffCollapsedFoldersForWorkspace);
  const stableExpandedPaths = expandedPaths ?? EMPTY_PATH_LIST;
  const stableCollapsedFolders = collapsedFolders ?? EMPTY_PATH_LIST;
  const folderPaths = useMemo(
    () => collectDirPaths(compressSingleChildChains(buildDiffTree(files))),
    [files],
  );
  const folderPathSet = useMemo(() => new Set(folderPaths), [folderPaths]);
  const allExpanded = useMemo(() => {
    if (files.length === 0 || changesTabOpen) {
      return false;
    }
    const everyFileExpanded = files.every((file) => stableExpandedPaths.includes(file.path));
    const everyFolderExpanded =
      viewMode !== "tree" ||
      stableCollapsedFolders.every((folderPath) => !folderPathSet.has(folderPath));
    return everyFileExpanded && everyFolderExpanded;
  }, [changesTabOpen, files, folderPathSet, stableCollapsedFolders, stableExpandedPaths, viewMode]);
  const toggleViewMode = useCallback(() => {
    const nextViewMode = viewMode === "flat" ? "tree" : "flat";
    if (nextViewMode === "tree" && workspaceStateKey) {
      setCollapsedFolders(workspaceStateKey, []);
    }
    onViewModeChange(nextViewMode);
  }, [onViewModeChange, setCollapsedFolders, viewMode, workspaceStateKey]);
  const toggleExpandAll = useCallback(() => {
    if (!workspaceStateKey) {
      return;
    }
    if (allExpanded) {
      setExpandedPaths(workspaceStateKey, []);
      if (viewMode === "tree") {
        setCollapsedFolders(workspaceStateKey, folderPaths);
      }
      return;
    }
    setExpandedPaths(
      workspaceStateKey,
      files.map((file) => file.path),
    );
    if (viewMode === "tree") {
      setCollapsedFolders(workspaceStateKey, []);
    }
  }, [
    allExpanded,
    files,
    folderPaths,
    setCollapsedFolders,
    setExpandedPaths,
    viewMode,
    workspaceStateKey,
  ]);
  const updateExpandedPaths = useCallback(
    (paths: string[]) => {
      if (workspaceStateKey) {
        setExpandedPaths(workspaceStateKey, paths);
      }
    },
    [setExpandedPaths, workspaceStateKey],
  );
  const updateCollapsedFolders = useCallback(
    (paths: string[]) => {
      if (workspaceStateKey) {
        setCollapsedFolders(workspaceStateKey, paths);
      }
    },
    [setCollapsedFolders, workspaceStateKey],
  );

  return {
    expandedPaths: changesTabOpen ? EMPTY_PATH_LIST : stableExpandedPaths,
    collapsedFolders: stableCollapsedFolders,
    allExpanded,
    toggleViewMode,
    toggleExpandAll,
    updateExpandedPaths,
    updateCollapsedFolders,
  };
}

function useDiffTabNavigation({
  serverId,
  workspaceId,
  cwd,
  isMobile,
}: {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  isMobile: boolean;
}) {
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const persistenceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? cwd }),
    [cwd, serverId, workspaceId],
  );
  const changesTabId = useWorkspaceLayoutStore((state) => {
    if (!persistenceKey) {
      return null;
    }
    const layout = state.layoutByWorkspace[persistenceKey];
    return (
      layout && collectAllTabs(layout.root).find((tab) => tab.target.kind === "working_diff")?.tabId
    );
  });
  const changesTabOpen = !isMobile && Boolean(changesTabId);
  const openChanges = useCallback(
    (path?: string) => {
      if (!persistenceKey || isMobile) {
        return;
      }
      openWorkspaceTabFocused(persistenceKey, {
        kind: "working_diff",
        ...(path ? { focusPath: path, focusRequestId: Date.now() } : {}),
      });
    },
    [isMobile, openWorkspaceTabFocused, persistenceKey],
  );
  const toggleChanges = useCallback(() => {
    if (!persistenceKey || isMobile) {
      return;
    }
    if (changesTabId) {
      closeWorkspaceTab(persistenceKey, changesTabId);
      return;
    }
    openChanges();
  }, [changesTabId, closeWorkspaceTab, isMobile, openChanges, persistenceKey]);
  const openCommit = useCallback(
    (sha: string) => {
      if (persistenceKey) {
        openWorkspaceTabFocused(persistenceKey, { kind: "commit_diff", sha });
      }
    },
    [openWorkspaceTabFocused, persistenceKey],
  );
  return {
    changesTabOpen,
    openChanges,
    toggleChanges,
    openCommit,
    onChangesFilePress: changesTabOpen ? openChanges : undefined,
  };
}

export function GitDiffPane({
  serverId,
  workspaceId,
  cwd,
  enabled,
  onOpenFile,
  onAddToChat,
}: GitDiffPaneProps) {
  const { settings: appSettings } = useAppSettings();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const canUseSplitLayout = isWeb && !isMobile;
  const { preferences: changesPreferences, updatePreferences: updateChangesPreferences } =
    useChangesPreferences();
  const wrapLines = changesPreferences.wrapLines;
  const viewMode = changesPreferences.viewMode;
  const effectiveLayout = resolveDiffLayout(changesPreferences.layout, canUseSplitLayout);

  const handleToggleWrapLines = useCallback(() => {
    void updateChangesPreferences({ wrapLines: !wrapLines });
  }, [updateChangesPreferences, wrapLines]);

  const handleToggleHideWhitespace = useCallback(() => {
    void updateChangesPreferences({ hideWhitespace: !changesPreferences.hideWhitespace });
  }, [changesPreferences.hideWhitespace, updateChangesPreferences]);

  const handleToggleLayout = useCallback(() => {
    void updateChangesPreferences({
      layout: changesPreferences.layout === "unified" ? "split" : "unified",
    });
  }, [changesPreferences.layout, updateChangesPreferences]);

  const codeFontSize = appSettings.codeFontSize;
  const layoutToggleStyle = useMemo(
    () => buildToggleButtonStyle(false, styles.expandAllButton),
    [],
  );

  const viewModeToggleStyle = useMemo(
    () => buildToggleButtonStyle(viewMode === "tree", styles.expandAllButton),
    [viewMode],
  );

  const expandAllToggleStyle = useMemo(() => buildExpandAllButtonStyle(), []);

  const overflowToggleStyle = useMemo(() => buildOverflowButtonStyle(), []);

  const toast = useToast();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  const {
    changesTabOpen,
    toggleChanges: handleToggleChangesTab,
    openCommit: handleCommitPress,
    onChangesFilePress,
  } = useDiffTabNavigation({ serverId, workspaceId, cwd, isMobile });
  const refreshSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  const runRefresh = useCheckoutGitActionsStore((s) => s.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((s) => s.getStatus({ serverId, cwd, actionId: "refresh" })) ===
    "pending";

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);

  const {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted: handleSelectUncommitted,
    selectBase: handleSelectBase,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
  } = useWorkingDiff({
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    ignoreWhitespace: changesPreferences.hideWhitespace,
    enabled: enabled !== false,
  });
  usePublishWorkingDiffAttachment({
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    attachment: reviewAttachment,
    enabled: !changesTabOpen,
  });
  const {
    githubFeaturesEnabled,
    forge,
    authState,
    payloadError: prPayloadError,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  const forgeProvidersSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.forgeProviders === true,
  );
  const forgeSetupAction = computeForgeSetupAction({
    forge,
    forgeProvidersSupported,
    authState,
  });
  const forgeSetupMessage = useMemo(
    () =>
      buildForgeSetupMessage({
        action: forgeSetupAction,
        forge,
        host: parseForgeHost(status?.remoteUrl),
        t,
      }),
    [forgeSetupAction, forge, status?.remoteUrl, t],
  );
  const handleViewModeChange = useCallback(
    (nextViewMode: "flat" | "tree") => {
      void updateChangesPreferences({ viewMode: nextViewMode });
    },
    [updateChangesPreferences],
  );
  const changesTree = useChangesTreeState({
    workspaceId,
    cwd,
    files,
    viewMode,
    changesTabOpen,
    onViewModeChange: handleViewModeChange,
  });
  const sharedDisplayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines,
      codeFontSize,
      monoFontFamily: appSettings.monoFontFamily,
    }),
    [appSettings.monoFontFamily, codeFontSize, effectiveLayout, wrapLines],
  );
  const downloadFile = useFileDownload({ serverId, workspaceId, workspaceRoot: cwd });
  const handleCopyPath = useCallback(
    (path: string) => {
      void Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: path }),
      );
    },
    [cwd],
  );
  const handleCopyRelativePath = useCallback((path: string) => {
    void Clipboard.setStringAsync(path);
  }, []);
  const handleRevealPath = useCallback(
    async (path: string) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: cwd,
          filePath: buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: path }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [cwd, fileManagerTarget, t, toast],
  );
  const handleDownloadPath = useCallback(
    (path: string) => {
      downloadFile({ fileName: path.split("/").pop() ?? path, path });
    },
    [downloadFile],
  );
  const handleDuplicatePath = useCallback(
    async (path: string) => {
      if (!client) {
        return;
      }
      try {
        const payload = await client.duplicateFileEntry({ cwd, path });
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, cwd, t, toast],
  );
  const onRevertPath = useDiscardChangesAction({ serverId, cwd, diffMode });
  const workingTreeMode = useMemo(
    () => ({
      kind: "working_tree" as const,
      viewMode,
      expandedPaths: changesTree.expandedPaths,
      collapsedFolders: changesTree.collapsedFolders,
      reviewActions,
      onFilePress: onChangesFilePress,
      workspaceFileDragScope: workspaceId ? { serverId, workspaceId } : undefined,
      onOpenFile,
      onAddToChat,
      onCopyPath: handleCopyPath,
      onCopyRelativePath: handleCopyRelativePath,
      onReveal: fileManagerTarget ? handleRevealPath : undefined,
      revealTargetName: fileManagerTarget?.label,
      onDownload: handleDownloadPath,
      onDuplicate: fsEntryDuplicateEnabled ? handleDuplicatePath : undefined,
      onRevert: onRevertPath,
      onExpandedPathsChange: changesTree.updateExpandedPaths,
      onCollapsedFoldersChange: changesTree.updateCollapsedFolders,
    }),
    [
      viewMode,
      changesTree.expandedPaths,
      changesTree.collapsedFolders,
      reviewActions,
      onChangesFilePress,
      serverId,
      workspaceId,
      onOpenFile,
      onAddToChat,
      handleCopyPath,
      handleCopyRelativePath,
      handleDownloadPath,
      handleDuplicatePath,
      handleRevealPath,
      fileManagerTarget,
      fsEntryDuplicateEnabled,
      onRevertPath,
      changesTree.updateExpandedPaths,
      changesTree.updateCollapsedFolders,
    ],
  );

  const hasChanges = files.length > 0;
  const diffErrorMessage = diffPayloadError?.message ?? null;
  const prErrorMessage = computePrErrorMessage(githubFeaturesEnabled, prPayloadError);
  const baseRefLabel = useMemo(
    () => computeBaseRefLabel(baseRef, t("workspace.git.diff.base")),
    [baseRef, t],
  );
  const { gitActions, branchLabel } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const committedDiffDescription = useMemo(
    () => computeCommittedDiffDescription(branchLabel, baseRefLabel),
    [baseRefLabel, branchLabel],
  );
  const emptyMessage = computeEmptyMessage(
    changesPreferences.hideWhitespace,
    diffMode,
    baseRefLabel,
    {
      hiddenWhitespace: t("workspace.git.diff.emptyHiddenWhitespace"),
      uncommitted: t("workspace.git.diff.emptyUncommitted"),
      againstBase: (label) => t("workspace.git.diff.emptyAgainstBase", { baseRef: label }),
    },
  );

  const bodyContent: ReactElement = (
    <DiffBodyContent
      isStatusLoading={isStatusLoading}
      statusErrorMessage={statusErrorMessage}
      notGit={notGit}
      isDiffLoading={isDiffLoading}
      diffErrorMessage={diffErrorMessage}
      diffTooLarge={diffTooLarge}
      hasChanges={hasChanges}
      emptyMessage={emptyMessage}
      checkingRepositoryLabel={t("workspace.git.diff.checkingRepository")}
      notRepositoryLabel={t("workspace.git.diff.notRepository")}
    >
      <SharedDiffView
        files={files}
        displayPreferences={sharedDisplayPreferences}
        mode={workingTreeMode}
      />
    </DiffBodyContent>
  );

  return (
    <View
      {...{
        onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
      }}
      style={styles.container}
    >
      {isGit && (currentBranchName || isMobile) ? (
        <View style={styles.header} testID="changes-header">
          <BranchSwitcher
            currentBranchName={currentBranchName}
            serverId={serverId}
            workspaceId={workspaceId ?? cwd}
            workspaceDirectory={cwd}
            isGitCheckout={isGit}
            testID="changes-branch-switcher"
          />
          {isMobile ? <GitActionsSplitButton gitActions={gitActions} /> : null}
        </View>
      ) : null}

      {isGit ? (
        <View style={styles.diffStatusContainer}>
          <View style={styles.diffStatusInner}>
            <DiffModeMenu
              diffMode={diffMode}
              committedDescription={committedDiffDescription}
              onSelectUncommitted={handleSelectUncommitted}
              onSelectBase={handleSelectBase}
            />
            <View style={styles.diffStatusButtons}>
              <ChangesTabToggle
                isMobile={isMobile}
                selected={changesTabOpen}
                onPress={handleToggleChangesTab}
              />
              {canUseSplitLayout && !changesTabOpen ? (
                <DiffLayoutToggle
                  layout={changesPreferences.layout}
                  isMobile={isMobile}
                  toggleStyle={layoutToggleStyle}
                  onToggle={handleToggleLayout}
                />
              ) : null}
              {files.length > 0 ? (
                <DiffViewModeToggle
                  viewMode={viewMode}
                  isMobile={isMobile}
                  toggleStyle={viewModeToggleStyle}
                  onToggle={changesTree.toggleViewMode}
                />
              ) : null}
              {files.length > 0 && !changesTabOpen ? (
                <DiffFilesToolbar
                  allFileDiffsExpanded={changesTree.allExpanded}
                  isMobile={isMobile}
                  expandAllToggleStyle={expandAllToggleStyle}
                  onToggleExpandAll={changesTree.toggleExpandAll}
                />
              ) : null}
              <DiffOptionsMenu
                brand={getForgePresentation(forge).brandLabel}
                hideWhitespace={changesPreferences.hideWhitespace}
                isMobile={isMobile}
                isRefreshing={isRefreshing}
                overflowToggleStyle={overflowToggleStyle}
                refreshSupported={refreshSupported}
                wrapLines={wrapLines}
                onRefresh={handleRefresh}
                onToggleHideWhitespace={handleToggleHideWhitespace}
                onToggleWrapLines={handleToggleWrapLines}
              />
            </View>
          </View>
        </View>
      ) : null}

      {forgeSetupMessage ? (
        <View style={styles.forgeSetupCallout} testID="forge-setup-callout">
          <Text style={styles.forgeSetupCalloutText}>{forgeSetupMessage}</Text>
        </View>
      ) : null}

      {prErrorMessage ? <Text style={styles.actionErrorText}>{prErrorMessage}</Text> : null}

      <View style={styles.diffContainer}>{bodyContent}</View>

      <CommitsSection serverId={serverId} cwd={cwd} onCommitPress={handleCommitPress} />
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
  overflowButton: {
    width: ICON_SIZE.sm + 2 * SPACING[1],
    height: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  actionErrorText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  forgeSetupCallout: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  forgeSetupCalloutText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scrollView: {
    flex: 1,
  },
  scrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
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
    paddingRight: WORKSPACE_FILE_ROW_TRAILING_PADDING,
    paddingVertical: WORKSPACE_FILE_ROW_VERTICAL_PADDING,
    gap: theme.spacing[1],
    minWidth: 0,
    zIndex: 2,
    elevation: 2,
  },
  fileHeaderActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  fileHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderLeftTree: {
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
  },
  fileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  fileChevronSpacer: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    flexShrink: 0,
  },
  fileIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  fileDirSpacer: {
    flex: 1,
    minWidth: 0,
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  diffGroupContent: {
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
    minWidth: 0,
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
  diffTextMetrics: {
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
  },
  lineNumberText: {
    width: "100%",
    textAlign: "right",
    paddingRight: theme.spacing[2],
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

const DIFF_HEIGHT_CHANGE_EPSILON = 0.5;
