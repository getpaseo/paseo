import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import {
  ActivityIndicator,
  Image as RNImage,
  ScrollView as RNScrollView,
  Text,
  View,
  type TextStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  createSharedMarkdownRules,
  MarkdownRenderer,
  type MarkdownStyles,
} from "@/components/markdown/renderer";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { isFileQueryEnabled } from "@/components/file-pane-enabled";
import {
  createFilePaneFindModel,
  createFilePaneHighlightMap,
  createFilePaneTextModel,
  splitFilePaneTokens,
  type FilePaneFindHighlight,
  type FilePaneFindTokenSegment,
  type FilePaneTextModel,
} from "@/components/file-pane-text-render-data";
import { PaneFindBar } from "@/pane-find/pane-find-bar";
import { usePaneFindRegistration } from "@/pane-find/use-pane-find-registration";
import { usePaneFindKey, usePaneFocus } from "@/panels/pane-context";
import { splitHighlightSegments } from "@/timeline-search/highlight";
import type { ASTNode, RenderRules } from "react-native-markdown-display";

interface CodeLineProps {
  segments: FilePaneFindTokenSegment[];
  lineNumber: number;
  gutterWidth: number;
  highlighted: boolean;
}

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  isLoading: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  imagePreviewUri: string | null;
  paneKey: string | null;
  isPaneFocused: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface FileLineSelection {
  lineStart: number;
  lineEnd: number;
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function createFilePanePreview(file: FileReadResult | null): Promise<{
  file: ExplorerFile | null;
  imageAttachment: AttachmentMetadata | null;
}> {
  if (!file) {
    return { file: null, imageAttachment: null };
  }

  const explorerFile = explorerFileFromReadResult(file);
  if (file.kind !== "image") {
    return { file: explorerFile, imageAttachment: null };
  }

  const imageAttachment = await persistAttachmentFromBytes({
    id: createPreviewAttachmentId({
      mimeType: file.mime,
      path: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt,
      contentLength: file.bytes.byteLength,
    }),
    bytes: file.bytes,
    mimeType: file.mime,
    fileName: getFileNameFromPath(file.path),
  });

  return {
    file: explorerFile,
    imageAttachment,
  };
}

function clampLineSelection(input: {
  lineStart?: number;
  lineEnd?: number;
  lineCount: number;
}): FileLineSelection | null {
  if (!input.lineStart || input.lineStart <= 0 || input.lineCount <= 0) {
    return null;
  }
  const lineStart = Math.min(Math.floor(input.lineStart), input.lineCount);
  const rawLineEnd =
    input.lineEnd && input.lineEnd >= input.lineStart ? input.lineEnd : input.lineStart;
  const lineEnd = Math.min(Math.floor(rawLineEnd), input.lineCount);
  return { lineStart, lineEnd: Math.max(lineStart, lineEnd) };
}

const CodeLine = React.memo(function CodeLine({
  segments,
  lineNumber,
  gutterWidth,
  highlighted,
}: CodeLineProps) {
  const gutterStyle = useMemo(
    () => [codeLineStyles.gutter, inlineUnistylesStyle({ width: gutterWidth })],
    [gutterWidth],
  );
  const lineStyle = useMemo(
    () => [codeLineStyles.line, highlighted && codeLineStyles.highlightedLine],
    [highlighted],
  );
  const keyedTokens = useMemo(
    () => segments.map((segment, index) => ({ key: `${index}-${segment.text}`, segment })),
    [segments],
  );
  return (
    <View style={lineStyle}>
      <View style={gutterStyle}>
        <Text numberOfLines={1} style={codeLineStyles.gutterText}>
          {String(lineNumber)}
        </Text>
      </View>
      <Text selectable style={codeLineStyles.lineText}>
        {keyedTokens.map(({ key, segment }) => (
          <CodeLineToken key={key} segment={segment} />
        ))}
      </Text>
    </View>
  );
});

interface CodeLineTokenProps {
  segment: FilePaneFindTokenSegment;
}

function CodeLineToken({ segment }: CodeLineTokenProps) {
  const tokenStyle = useMemo(() => {
    if (segment.match === "current") {
      return [syntaxTokenStyleFor(segment.style), codeLineStyles.currentFindMatch];
    }
    if (segment.match === "ordinary") {
      return [syntaxTokenStyleFor(segment.style), codeLineStyles.findMatch];
    }
    return syntaxTokenStyleFor(segment.style);
  }, [segment.match, segment.style]);
  return <Text style={tokenStyle}>{segment.text}</Text>;
}

const codeLineStyles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
  },
  highlightedLine: {
    backgroundColor: theme.colors.accentBorder,
  },
  findMatch: {
    backgroundColor: theme.colors.searchHighlight,
    color: theme.colors.accentForeground,
  },
  currentFindMatch: {
    backgroundColor: theme.colors.searchHighlightActive,
    color: theme.colors.searchHighlightActiveForeground,
  },
  gutter: {
    alignItems: "flex-end",
    paddingRight: theme.spacing[3],
    flexShrink: 0,
  },
  gutterText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.45,
    opacity: 0.4,
    userSelect: "none",
  },
  lineText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.45,
    flex: 1,
  },
}));

interface TextFindViewProps {
  textModel: FilePaneTextModel;
  highlightsByLine: Map<number, FilePaneFindHighlight[]>;
  gutterWidth: number;
  isMobile: boolean;
  lineSelection: FileLineSelection | null;
}

// Shared read-only rendering for a line-numbered, find-highlighted monospace text block.
// Used both for syntax-highlighted code files and (see the markdown find fix below) the raw
// markdown source view shown while a find query is active over a rendered-markdown file.
function TextFindView({
  textModel,
  highlightsByLine,
  gutterWidth,
  isMobile,
  lineSelection,
}: TextFindViewProps) {
  const codeLines = (
    <View dataSet={CODE_SURFACE_DATASET}>
      {textModel.lines.map((line) => {
        const isSelected =
          Boolean(lineSelection) &&
          line.lineNumber >= (lineSelection?.lineStart ?? 0) &&
          line.lineNumber <= (lineSelection?.lineEnd ?? 0);
        return (
          <CodeLine
            key={`line-${line.lineNumber}`}
            segments={splitFilePaneTokens(line, highlightsByLine.get(line.lineNumber) ?? [])}
            lineNumber={line.lineNumber}
            gutterWidth={gutterWidth}
            highlighted={isSelected}
          />
        );
      })}
    </View>
  );

  if (isMobile) {
    return <View style={styles.previewCodeScrollContent}>{codeLines}</View>;
  }

  return (
    <RNScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      contentContainerStyle={styles.previewCodeScrollContent}
    >
      {codeLines}
    </RNScrollView>
  );
}

interface SearchableCodeProps {
  highlightedLines: HighlightToken[][];
  gutterWidth: number;
  isMobile: boolean;
  lineHeight: number;
  lineSelection: FileLineSelection | null;
  paneKey: string | null;
  isPaneFocused: boolean;
  previewScrollRef: React.RefObject<RNScrollView | null>;
}

function SearchableCode({
  highlightedLines,
  gutterWidth,
  isMobile,
  lineHeight,
  lineSelection,
  paneKey,
  isPaneFocused,
  previewScrollRef,
}: SearchableCodeProps) {
  const textModel = useMemo(() => createFilePaneTextModel(highlightedLines), [highlightedLines]);
  const findModel = useMemo(
    () =>
      createFilePaneFindModel({
        textModel,
        onSelectLine(lineNumber) {
          previewScrollRef.current?.scrollTo({
            y: Math.max(0, (lineNumber - 1) * lineHeight),
            animated: true,
          });
        },
      }),
    [lineHeight, previewScrollRef, textModel],
  );
  const findState = useSyncExternalStore(
    findModel.adapter.subscribe,
    findModel.adapter.getState,
    findModel.adapter.getState,
  );
  usePaneFindRegistration({ paneKey, adapter: findModel.adapter });

  // Policy (matches terminal-pane.tsx): when this pane loses find focus, clear the find
  // state entirely (query + matches + bar) rather than merely hiding the bar while
  // highlights linger from a stale query.
  useEffect(() => {
    if (isPaneFocused) {
      return undefined;
    }
    findModel.adapter.close();
    return undefined;
  }, [findModel, isPaneFocused]);

  const highlightsByLine = useMemo(
    () => createFilePaneHighlightMap(findModel.getMatches(), findState.selectedIndex),
    [findModel, findState],
  );

  return (
    <TextFindView
      textModel={textModel}
      highlightsByLine={highlightsByLine}
      gutterWidth={gutterWidth}
      isMobile={isMobile}
      lineSelection={lineSelection}
    />
  );
}

function markdownSourceLines(content: string): HighlightToken[][] {
  return content.split("\n").map((text) => [{ text, style: null }]);
}

interface MarkdownFileViewProps {
  content: string;
  paneKey: string | null;
  isPaneFocused: boolean;
  lineHeight: number;
  previewScrollRef: React.RefObject<RNScrollView | null>;
}

function MarkdownFindText({
  content,
  query,
  textStyle,
  inheritedStyles,
}: {
  content: string;
  query: string;
  textStyle: TextStyle;
  inheritedStyles: TextStyle;
}) {
  const segments = useMemo(() => splitHighlightSegments(content, query), [content, query]);
  const style = useMemo(() => [inheritedStyles, textStyle], [inheritedStyles, textStyle]);

  return (
    <MarkdownTextSpan style={style}>
      {segments.map((segment) =>
        segment.isMatch ? (
          <MarkdownTextSpan key={segment.offset} style={codeLineStyles.findMatch}>
            {segment.text}
          </MarkdownTextSpan>
        ) : (
          segment.text
        ),
      )}
    </MarkdownTextSpan>
  );
}

// Keep Markdown files rendered while find is active. Source-line matching still
// drives the pane-find count and navigation, while this rule highlights matches
// in parsed text leaves instead of replacing the preview with raw source.
function MarkdownFileView({
  content,
  paneKey,
  isPaneFocused,
  lineHeight,
  previewScrollRef,
}: MarkdownFileViewProps) {
  const textModel = useMemo(() => createFilePaneTextModel(markdownSourceLines(content)), [content]);
  const findModel = useMemo(
    () =>
      createFilePaneFindModel({
        textModel,
        onSelectLine(lineNumber) {
          previewScrollRef.current?.scrollTo({
            y: Math.max(0, (lineNumber - 1) * lineHeight),
            animated: true,
          });
        },
      }),
    [lineHeight, previewScrollRef, textModel],
  );
  const findState = useSyncExternalStore(
    findModel.adapter.subscribe,
    findModel.adapter.getState,
    findModel.adapter.getState,
  );
  usePaneFindRegistration({ paneKey, adapter: findModel.adapter });

  useEffect(() => {
    if (isPaneFocused) {
      return undefined;
    }
    findModel.adapter.close();
    return undefined;
  }, [findModel, isPaneFocused]);

  const renderedMarkdownRules = useMemo<RenderRules | undefined>(() => {
    const query = findState.query;
    if (query.length === 0) return undefined;
    return {
      ...createSharedMarkdownRules(),
      text: (
        node: ASTNode,
        _children: React.ReactNode[],
        _parent: ASTNode[],
        markdownStyles: MarkdownStyles,
        inheritedStyles: TextStyle = {},
      ) => (
        <MarkdownFindText
          key={node.key}
          content={node.content}
          query={query}
          textStyle={markdownStyles.text}
          inheritedStyles={inheritedStyles}
        />
      ),
    };
  }, [findState.query]);

  return <MarkdownRenderer text={content} rules={renderedMarkdownRules} />;
}

function FilePreviewBody({
  preview,
  isLoading,
  isMobile,
  location,
  imagePreviewUri,
  paneKey,
  isPaneFocused,
}: FilePreviewBodyProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const filePath = location.path;
  const isMarkdownFile =
    preview?.kind === "text" && isRenderedMarkdownFile(filePath) && !location.lineStart;

  const previewScrollRef = useRef<RNScrollView>(null);

  const highlightedLines = useMemo(() => {
    if (!preview || preview.kind !== "text" || isMarkdownFile) {
      return null;
    }

    return highlightCode(preview.content ?? "", filePath);
  }, [isMarkdownFile, preview, filePath]);

  const gutterWidth = useMemo(() => {
    if (!highlightedLines) return 0;
    return lineNumberGutterWidth(highlightedLines.length, theme.fontSize.code);
  }, [highlightedLines, theme.fontSize.code]);
  const lineHeight = theme.fontSize.code * 1.45;
  const lineSelection = useMemo(() => {
    if (!highlightedLines) {
      return null;
    }
    return clampLineSelection({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      lineCount: highlightedLines.length,
    });
  }, [highlightedLines, location.lineEnd, location.lineStart]);

  const imageSource = useMemo(
    () => (imagePreviewUri ? { uri: imagePreviewUri } : null),
    [imagePreviewUri],
  );

  useEffect(() => {
    if (!lineSelection) {
      return;
    }
    const timeout = setTimeout(() => {
      previewScrollRef.current?.scrollTo({
        y: Math.max(0, (lineSelection.lineStart - 1) * lineHeight),
        animated: false,
      });
    }, 0);
    return () => clearTimeout(timeout);
  }, [lineHeight, lineSelection]);

  if (isLoading && !preview) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
      </View>
    );
  }

  if (preview.kind === "text") {
    if (isMarkdownFile) {
      return (
        <View style={styles.previewScrollContainer}>
          {isPaneFocused ? <PaneFindBar placement="inline" testID="file-pane-find-bar" /> : null}
          <RNScrollView
            ref={previewScrollRef}
            style={styles.previewContent}
            contentContainerStyle={styles.previewMarkdownScrollContent}
            showsVerticalScrollIndicator
          >
            <MarkdownFileView
              content={preview.content ?? ""}
              paneKey={paneKey}
              isPaneFocused={isPaneFocused}
              lineHeight={lineHeight}
              previewScrollRef={previewScrollRef}
            />
          </RNScrollView>
        </View>
      );
    }

    if (!highlightedLines) {
      return (
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
        </View>
      );
    }

    return (
      <View style={styles.previewScrollContainer}>
        {/*
          The find bar must live in this non-scrolling container, not inside
          the RNScrollView below — otherwise jumping to a match scrolls the
          bar itself out of view while its input keeps keyboard focus.
          Mirrors the pattern in terminal-pane.tsx (outputContainer).
        */}
        {isPaneFocused ? <PaneFindBar placement="inline" testID="file-pane-find-bar" /> : null}
        <RNScrollView
          ref={previewScrollRef}
          style={styles.previewContent}
          showsVerticalScrollIndicator
        >
          <SearchableCode
            highlightedLines={highlightedLines}
            gutterWidth={gutterWidth}
            isMobile={isMobile}
            lineHeight={lineHeight}
            lineSelection={lineSelection}
            paneKey={paneKey}
            isPaneFocused={isPaneFocused}
            previewScrollRef={previewScrollRef}
          />
        </RNScrollView>
      </View>
    );
  }

  if (preview.kind === "image") {
    if (!imagePreviewUri) {
      return (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" />
          <Text style={styles.loadingText}>{t("panels.file.loading")}</Text>
        </View>
      );
    }

    return (
      <View style={styles.previewScrollContainer}>
        <RNScrollView
          ref={previewScrollRef}
          style={styles.previewContent}
          contentContainerStyle={styles.previewImageScrollContent}
          showsVerticalScrollIndicator
        >
          <RNImage
            source={imageSource ?? undefined}
            style={styles.previewImage}
            resizeMode="contain"
          />
        </RNScrollView>
      </View>
    );
  }

  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
      <Text style={styles.binaryMetaText}>{formatFileSize({ size: preview.size })}</Text>
    </View>
  );
}

export function FilePane({
  serverId,
  workspaceRoot,
  location,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
}) {
  const { t } = useTranslation();
  const paneFocus = usePaneFocus();
  const paneFindKey = usePaneFindKey();
  const isMobile = useIsCompactFormFactor();

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedFilePath = useMemo(() => trimNonEmpty(location.path), [location.path]);
  const readTarget = useMemo(
    () =>
      normalizedFilePath
        ? resolveFilePreviewReadTarget({
            path: normalizedFilePath,
            workspaceRoot: normalizedWorkspaceRoot,
          })
        : null,
    [normalizedFilePath, normalizedWorkspaceRoot],
  );

  // Re-read the file when this pane becomes visible again (#445). `isActive`
  // covers tab switches, `isAppVisible` the whole-app background/foreground; the
  // gate itself lives in isFileQueryEnabled.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();

  const query = useQuery({
    queryKey: ["workspaceFile", serverId, readTarget?.cwd ?? null, readTarget?.path ?? null],
    enabled: isFileQueryEnabled({
      hasReadTarget: Boolean(client && readTarget),
      isTabActive: isActive,
      isAppVisible,
    }),
    queryFn: async () => {
      if (!client || !readTarget) {
        return {
          file: null as ExplorerFile | null,
          error: t("workspace.terminal.hostDisconnected"),
        };
      }
      try {
        const file = await client.readFile(readTarget.cwd, readTarget.path);
        const preview = await createFilePanePreview(file);
        return {
          file: preview.file,
          imageAttachment: preview.imageAttachment,
          error: null,
        };
      } catch (error) {
        return {
          file: null,
          imageAttachment: null,
          error: error instanceof Error ? error.message : t("panels.file.failedToLoad"),
        };
      }
    },
    staleTime: 5_000,
    refetchOnMount: true,
  });
  const imagePreviewUri = useAttachmentPreviewUrl(query.data?.imageAttachment ?? null);

  return (
    <View style={styles.container} testID="workspace-file-pane">
      {query.data?.error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{query.data.error}</Text>
        </View>
      ) : null}

      <FilePreviewBody
        preview={query.data?.file ?? null}
        isLoading={query.isFetching}
        isMobile={isMobile}
        location={location}
        imagePreviewUri={imagePreviewUri}
        paneKey={paneFindKey}
        isPaneFocused={paneFocus.isInteractive}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  binaryMetaText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  previewContent: {
    flex: 1,
    minHeight: 0,
  },
  previewCodeScrollContent: {
    padding: theme.spacing[4],
  },
  previewMarkdownScrollContent: {
    padding: theme.spacing[4],
  },
  previewImageScrollContent: {
    flexGrow: 1,
    padding: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  previewImage: {
    width: "100%",
    height: 420,
  },
}));
