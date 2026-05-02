import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileReadResult } from "@server/client/daemon-client";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import {
  ActivityIndicator,
  Image as RNImage,
  ScrollView as RNScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Fonts } from "@/constants/theme";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";
import {
  darkHighlightColors,
  lightHighlightColors,
  type HighlightStyle,
} from "@getpaseo/highlight";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import { isWeb } from "@/constants/platform";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import {
  createFilePaneFindTokenSegments,
  createFilePaneLineFindHighlightMap,
  createFilePaneTextRenderData,
  findFilePaneTextMatches,
  type FilePaneFindLineHighlight,
  type FilePaneFindMatch,
  type FilePaneFindTokenSegment,
} from "@/components/file-pane-text-render-data";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import {
  FindBar,
  type PaneFindMatchState,
  type UsePaneFindResult,
  usePaneFind,
} from "@/panels/pane-find";

interface CodeLineProps {
  segments: FilePaneFindTokenSegment[];
  lineNumber: number;
  gutterWidth: number;
  colorMap: Record<HighlightStyle, string>;
  baseColor: string;
  matchBackgroundColor: string;
  currentMatchBackgroundColor: string;
  onLineRef?: (lineNumber: number, node: View | null) => void;
}

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  isLoading: boolean;
  showDesktopWebScrollbar: boolean;
  isMobile: boolean;
  filePath: string;
  imagePreviewUri: string | null;
}

interface FilePaneTextScrollRefs {
  lineRefs: React.MutableRefObject<Map<number, View>>;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  registerLineRef: (lineNumber: number, node: View | null) => void;
}

interface FilePaneCenterStateProps {
  children: React.ReactNode;
}

interface FilePaneTextPreviewProps {
  baseColor: string;
  colorMap: Record<HighlightStyle, string>;
  currentMatchBackgroundColor: string;
  findHighlightsByLine: Map<number, FilePaneFindLineHighlight[]>;
  gutterWidth: number;
  isMarkdownFile: boolean;
  isMobile: boolean;
  markdownParser: ReturnType<typeof MarkdownIt>;
  markdownStyles: ReturnType<typeof createMarkdownStyles>;
  matchBackgroundColor: string;
  preview: ExplorerFile;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  scrollbar: ReturnType<typeof useWebScrollViewScrollbar>;
  showDesktopWebScrollbar: boolean;
  textRenderData: ReturnType<typeof createFilePaneTextRenderData> | null;
  textScrollRefs: FilePaneTextScrollRefs;
  webScrollbarStyle: object;
}

interface FilePaneImagePreviewProps {
  imagePreviewUri: string | null;
  imageSource: { uri: string } | null;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  scrollbar: ReturnType<typeof useWebScrollViewScrollbar>;
  showDesktopWebScrollbar: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

const CodeLine = React.memo(function CodeLine({
  segments,
  lineNumber,
  gutterWidth,
  colorMap,
  baseColor,
  matchBackgroundColor,
  currentMatchBackgroundColor,
  onLineRef,
}: CodeLineProps) {
  const setLineRef = useCallback(
    (node: View | null) => {
      onLineRef?.(lineNumber, node);
    },
    [lineNumber, onLineRef],
  );
  const gutterStyle = useMemo(() => [codeLineStyles.gutter, { width: gutterWidth }], [gutterWidth]);
  const gutterTextStyle = useMemo(
    () => [codeLineStyles.gutterText, { color: baseColor }],
    [baseColor],
  );
  const keyedTokens = useMemo(
    () => segments.map((segment, index) => ({ key: `${index}-${segment.text}`, segment })),
    [segments],
  );
  return (
    <View ref={setLineRef} style={codeLineStyles.line}>
      <View style={gutterStyle}>
        <Text numberOfLines={1} style={gutterTextStyle}>
          {String(lineNumber)}
        </Text>
      </View>
      <Text selectable style={codeLineStyles.lineText}>
        {keyedTokens.map(({ key, segment }) => (
          <CodeLineToken
            key={key}
            backgroundColor={getFindSegmentBackgroundColor({
              currentMatchBackgroundColor,
              matchBackgroundColor,
              segment,
            })}
            color={segment.style ? (colorMap[segment.style] ?? baseColor) : baseColor}
            text={segment.text}
          />
        ))}
      </Text>
    </View>
  );
});

interface CodeLineTokenProps {
  backgroundColor?: string;
  color: string;
  text: string;
}

function CodeLineToken({ backgroundColor, color, text }: CodeLineTokenProps) {
  const style = useMemo(() => ({ backgroundColor, color }), [backgroundColor, color]);
  return <Text style={style}>{text}</Text>;
}

function getFindSegmentBackgroundColor(input: {
  segment: FilePaneFindTokenSegment;
  matchBackgroundColor: string;
  currentMatchBackgroundColor: string;
}) {
  if (input.segment.isCurrentFindMatch) {
    return input.currentMatchBackgroundColor;
  }
  if (input.segment.isFindMatch) {
    return input.matchBackgroundColor;
  }
  return undefined;
}

function useFilePaneTextScrollRefs(lineNumbers: number[] | null): FilePaneTextScrollRefs {
  const previewScrollRef = useRef<RNScrollView>(null);
  const lineRefs = useRef(new Map<number, View>());

  const registerLineRef = useCallback((lineNumber: number, node: View | null) => {
    if (node) {
      lineRefs.current.set(lineNumber, node);
      return;
    }
    lineRefs.current.delete(lineNumber);
  }, []);

  useEffect(() => {
    if (!lineNumbers) {
      lineRefs.current.clear();
      return;
    }

    const visibleLineNumbers = new Set(lineNumbers);
    for (const lineNumber of lineRefs.current.keys()) {
      if (!visibleLineNumbers.has(lineNumber)) {
        lineRefs.current.delete(lineNumber);
      }
    }
  }, [lineNumbers]);

  return {
    lineRefs,
    previewScrollRef,
    registerLineRef,
  };
}

function createFilePaneMatchState(
  query: string,
  matches: FilePaneFindMatch[],
  currentMatchIndex: number,
): PaneFindMatchState {
  if (query.length === 0) {
    return { status: "empty" };
  }
  if (matches.length === 0) {
    return { status: "no-match" };
  }
  return {
    status: "matched",
    current: Math.max(0, currentMatchIndex) + 1,
    total: matches.length,
  };
}

function scrollFilePaneLineIntoView(input: {
  lineRefs: React.MutableRefObject<Map<number, View>>;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  lineNumber: number;
}) {
  const lineNode = input.lineRefs.current.get(input.lineNumber);
  const scrollNode = input.previewScrollRef.current;
  if (!lineNode || !scrollNode) {
    return;
  }

  if (isWeb && "scrollIntoView" in lineNode) {
    (
      lineNode as unknown as { scrollIntoView(options?: ScrollIntoViewOptions): void }
    ).scrollIntoView({
      block: "center",
      inline: "nearest",
    });
    return;
  }

  const measurableLineNode = lineNode as View & {
    measureLayout?: (
      relativeToNativeNode: unknown,
      onSuccess: (x: number, y: number) => void,
      onFail?: () => void,
    ) => void;
  };
  measurableLineNode.measureLayout?.(scrollNode, (_x, y) => {
    scrollNode.scrollTo({ y: Math.max(0, y - 48), animated: true });
  });
}

function scrollFilePaneLineIntoViewSoon(input: {
  lineRefs: React.MutableRefObject<Map<number, View>>;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  lineNumber: number;
}) {
  const schedule =
    globalThis.requestAnimationFrame ??
    ((callback: FrameRequestCallback) => {
      setTimeout(() => callback(Date.now()), 0);
      return 0;
    });
  schedule(() => {
    scrollFilePaneLineIntoView(input);
  });
}

interface FilePaneFindState {
  query: string;
  matches: FilePaneFindMatch[];
  currentMatchIndex: number;
}

const EMPTY_FILE_PANE_FIND_STATE: FilePaneFindState = {
  query: "",
  matches: [],
  currentMatchIndex: 0,
};

function useFilePaneFindAdapter(input: {
  textRenderData: ReturnType<typeof createFilePaneTextRenderData> | null;
  textScrollRefs: FilePaneTextScrollRefs;
}) {
  const [findState, setFindState] = useState<FilePaneFindState>(EMPTY_FILE_PANE_FIND_STATE);
  const findQuery = findState.query;
  const findMatches = findState.matches;
  const currentMatchIndex = findState.currentMatchIndex;
  const findHighlightsByLine = useMemo(
    () => createFilePaneLineFindHighlightMap(findMatches, currentMatchIndex),
    [currentMatchIndex, findMatches],
  );
  const findMatchState = useMemo(
    () => createFilePaneMatchState(findQuery, findMatches, currentMatchIndex),
    [currentMatchIndex, findMatches, findQuery],
  );
  const scrollMatchIntoView = useCallback(
    (matches: FilePaneFindMatch[], matchIndex: number) => {
      const lineNumber = matches[matchIndex]?.lineSpans[0]?.lineNumber;
      if (!lineNumber) {
        return;
      }
      scrollFilePaneLineIntoViewSoon({
        lineRefs: input.textScrollRefs.lineRefs,
        lineNumber,
        previewScrollRef: input.textScrollRefs.previewScrollRef,
      });
    },
    [input.textScrollRefs.lineRefs, input.textScrollRefs.previewScrollRef],
  );
  const paneFind = usePaneFind({
    matchState: findMatchState,
    onQuery: (query) => {
      const nextMatches = input.textRenderData
        ? findFilePaneTextMatches(input.textRenderData, query)
        : [];
      setFindState({ query, matches: nextMatches, currentMatchIndex: 0 });
      scrollMatchIntoView(nextMatches, 0);
      return createFilePaneMatchState(query, nextMatches, 0);
    },
    onNext: () => {
      if (findMatches.length === 0) {
        return createFilePaneMatchState(findQuery, findMatches, currentMatchIndex);
      }
      const nextIndex = (currentMatchIndex + 1) % findMatches.length;
      setFindState((current) => ({ ...current, currentMatchIndex: nextIndex }));
      scrollMatchIntoView(findMatches, nextIndex);
      return createFilePaneMatchState(findQuery, findMatches, nextIndex);
    },
    onPrev: () => {
      if (findMatches.length === 0) {
        return createFilePaneMatchState(findQuery, findMatches, currentMatchIndex);
      }
      const nextIndex = (currentMatchIndex - 1 + findMatches.length) % findMatches.length;
      setFindState((current) => ({ ...current, currentMatchIndex: nextIndex }));
      scrollMatchIntoView(findMatches, nextIndex);
      return createFilePaneMatchState(findQuery, findMatches, nextIndex);
    },
    onClose: () => {
      setFindState(EMPTY_FILE_PANE_FIND_STATE);
    },
  });

  useEffect(() => {
    setFindState((current) => {
      if (!input.textRenderData || current.query.length === 0) {
        return current.query.length === 0 &&
          current.matches.length === 0 &&
          current.currentMatchIndex === 0
          ? current
          : EMPTY_FILE_PANE_FIND_STATE;
      }

      const nextMatches = findFilePaneTextMatches(input.textRenderData, current.query);
      const nextMatchIndex =
        nextMatches.length === 0 ? 0 : Math.min(current.currentMatchIndex, nextMatches.length - 1);

      return {
        query: current.query,
        matches: nextMatches,
        currentMatchIndex: nextMatchIndex,
      };
    });
  }, [input.textRenderData]);

  return {
    findHighlightsByLine,
    paneFind,
  };
}

const codeLineStyles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
  },
  gutter: {
    alignItems: "flex-end",
    paddingRight: theme.spacing[3],
    flexShrink: 0,
  },
  gutterText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.45,
    opacity: 0.4,
    userSelect: "none",
  },
  lineText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.45,
    flex: 1,
  },
}));

function FilePaneFindBarSlot({ paneFind }: { paneFind: UsePaneFindResult }) {
  return paneFind.isOpen ? <FindBar {...paneFind.findBarProps} /> : null;
}

function FilePaneCenterState({ children }: FilePaneCenterStateProps) {
  return <View style={styles.centerState}>{children}</View>;
}

function FilePaneTextPreview({
  baseColor,
  colorMap,
  currentMatchBackgroundColor,
  findHighlightsByLine,
  gutterWidth,
  isMarkdownFile,
  isMobile,
  markdownParser,
  markdownStyles,
  matchBackgroundColor,
  preview,
  previewScrollRef,
  scrollbar,
  showDesktopWebScrollbar,
  textRenderData,
  textScrollRefs,
  webScrollbarStyle,
}: FilePaneTextPreviewProps) {
  if (isMarkdownFile) {
    return (
      <>
        <RNScrollView
          ref={previewScrollRef}
          style={styles.previewContent}
          contentContainerStyle={styles.previewMarkdownScrollContent}
          onLayout={scrollbar.onLayout}
          onScroll={scrollbar.onScroll}
          onContentSizeChange={scrollbar.onContentSizeChange}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={!showDesktopWebScrollbar}
        >
          <Markdown style={markdownStyles} markdownit={markdownParser}>
            {preview.content ?? ""}
          </Markdown>
        </RNScrollView>
        {scrollbar.overlay}
      </>
    );
  }

  const lines = textRenderData?.lines ?? [
    {
      lineNumber: 1,
      text: preview.content ?? "",
      tokens: [{ text: preview.content ?? "", style: null }],
    },
  ];
  const keyedLines = lines.map((line) => ({
    key: `line-${line.lineNumber}`,
    line,
  }));
  const codeLines = (
    <View>
      {keyedLines.map(({ key, line }) => (
        <CodeLine
          key={key}
          segments={createFilePaneFindTokenSegments(
            line,
            findHighlightsByLine.get(line.lineNumber) ?? [],
          )}
          lineNumber={line.lineNumber}
          gutterWidth={gutterWidth}
          colorMap={colorMap}
          baseColor={baseColor}
          matchBackgroundColor={matchBackgroundColor}
          currentMatchBackgroundColor={currentMatchBackgroundColor}
          onLineRef={textScrollRefs.registerLineRef}
        />
      ))}
    </View>
  );

  return (
    <>
      <RNScrollView
        ref={previewScrollRef}
        style={styles.previewContent}
        onLayout={scrollbar.onLayout}
        onScroll={scrollbar.onScroll}
        onContentSizeChange={scrollbar.onContentSizeChange}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={!showDesktopWebScrollbar}
      >
        {isMobile ? (
          <View style={styles.previewCodeScrollContent}>{codeLines}</View>
        ) : (
          <RNScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            style={webScrollbarStyle}
            contentContainerStyle={styles.previewCodeScrollContent}
          >
            {codeLines}
          </RNScrollView>
        )}
      </RNScrollView>
      {scrollbar.overlay}
    </>
  );
}

function FilePaneImagePreview({
  imagePreviewUri,
  imageSource,
  previewScrollRef,
  scrollbar,
  showDesktopWebScrollbar,
}: FilePaneImagePreviewProps) {
  if (!imagePreviewUri) {
    return (
      <FilePaneCenterState>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>Loading file…</Text>
      </FilePaneCenterState>
    );
  }

  return (
    <>
      <RNScrollView
        ref={previewScrollRef}
        style={styles.previewContent}
        contentContainerStyle={styles.previewImageScrollContent}
        onLayout={scrollbar.onLayout}
        onScroll={scrollbar.onScroll}
        onContentSizeChange={scrollbar.onContentSizeChange}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={!showDesktopWebScrollbar}
      >
        <RNImage
          source={imageSource ?? undefined}
          style={styles.previewImage}
          resizeMode="contain"
        />
      </RNScrollView>
      {scrollbar.overlay}
    </>
  );
}

function FilePreviewBody({
  preview,
  isLoading,
  showDesktopWebScrollbar,
  isMobile,
  filePath,
  imagePreviewUri,
}: FilePreviewBodyProps) {
  const { theme } = useUnistyles();
  const isDark = theme.colorScheme === "dark";
  const colorMap = isDark ? darkHighlightColors : lightHighlightColors;
  const baseColor = isDark ? "#c9d1d9" : "#24292f";
  const matchBackgroundColor = isDark ? "rgba(250, 204, 21, 0.32)" : "rgba(250, 204, 21, 0.38)";
  const currentMatchBackgroundColor = isDark
    ? "rgba(251, 146, 60, 0.58)"
    : "rgba(251, 146, 60, 0.48)";
  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
  const markdownParser = useMemo(() => MarkdownIt({ typographer: true, linkify: true }), []);
  const isMarkdownFile = preview?.kind === "text" && isRenderedMarkdownFile(filePath);

  const fallbackScrollRef = useRef<RNScrollView>(null);
  const webScrollbarStyle = useWebScrollbarStyle();

  const textRenderData = useMemo(() => {
    if (!preview || preview.kind !== "text" || isMarkdownFile) {
      return null;
    }

    return createFilePaneTextRenderData(preview.content ?? "", filePath);
  }, [isMarkdownFile, preview, filePath]);
  const textLineNumbers = useMemo(
    () => textRenderData?.lines.map((line) => line.lineNumber) ?? null,
    [textRenderData],
  );
  const textScrollRefs = useFilePaneTextScrollRefs(textLineNumbers);
  const previewScrollRef = textRenderData ? textScrollRefs.previewScrollRef : fallbackScrollRef;
  const scrollbar = useWebScrollViewScrollbar(previewScrollRef, {
    enabled: showDesktopWebScrollbar,
  });
  const { findHighlightsByLine, paneFind } = useFilePaneFindAdapter({
    textRenderData,
    textScrollRefs,
  });

  const gutterWidth = useMemo(() => {
    if (!textRenderData) return 0;
    return lineNumberGutterWidth(textRenderData.lines.length, theme.fontSize.sm);
  }, [textRenderData, theme.fontSize.sm]);

  const imageSource = useMemo(
    () => (imagePreviewUri ? { uri: imagePreviewUri } : null),
    [imagePreviewUri],
  );

  let content: React.ReactNode;
  if (isLoading && !preview) {
    content = (
      <FilePaneCenterState>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>Loading file…</Text>
      </FilePaneCenterState>
    );
  } else if (!preview) {
    content = (
      <FilePaneCenterState>
        <Text style={styles.emptyText}>No preview available</Text>
      </FilePaneCenterState>
    );
  } else if (preview.kind === "text") {
    content = (
      <FilePaneTextPreview
        baseColor={baseColor}
        colorMap={colorMap}
        currentMatchBackgroundColor={currentMatchBackgroundColor}
        findHighlightsByLine={findHighlightsByLine}
        gutterWidth={gutterWidth}
        isMarkdownFile={isMarkdownFile}
        isMobile={isMobile}
        markdownParser={markdownParser}
        markdownStyles={markdownStyles}
        matchBackgroundColor={matchBackgroundColor}
        preview={preview}
        previewScrollRef={previewScrollRef}
        scrollbar={scrollbar}
        showDesktopWebScrollbar={showDesktopWebScrollbar}
        textRenderData={textRenderData}
        textScrollRefs={textScrollRefs}
        webScrollbarStyle={webScrollbarStyle}
      />
    );
  } else if (preview.kind === "image") {
    content = (
      <FilePaneImagePreview
        imagePreviewUri={imagePreviewUri}
        imageSource={imageSource}
        previewScrollRef={previewScrollRef}
        scrollbar={scrollbar}
        showDesktopWebScrollbar={showDesktopWebScrollbar}
      />
    );
  } else {
    content = (
      <FilePaneCenterState>
        <Text style={styles.emptyText}>Binary preview unavailable</Text>
        <Text style={styles.binaryMetaText}>{formatFileSize({ size: preview.size })}</Text>
      </FilePaneCenterState>
    );
  }

  return (
    <View style={styles.previewScrollContainer}>
      <FilePaneFindBarSlot paneFind={paneFind} />
      {content}
    </View>
  );
}

export function FilePane({
  serverId,
  workspaceRoot,
  filePath,
}: {
  serverId: string;
  workspaceRoot: string;
  filePath: string;
}) {
  const isMobile = useIsCompactFormFactor();
  const showDesktopWebScrollbar = isWeb && !isMobile;

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedFilePath = useMemo(() => trimNonEmpty(filePath), [filePath]);

  const query = useQuery({
    queryKey: ["workspaceFile", serverId, normalizedWorkspaceRoot, normalizedFilePath],
    enabled: Boolean(client && normalizedWorkspaceRoot && normalizedFilePath),
    queryFn: async () => {
      if (!client || !normalizedWorkspaceRoot || !normalizedFilePath) {
        return { file: null as ExplorerFile | null, error: "Host is not connected" };
      }
      try {
        const file = await client.readFile(normalizedWorkspaceRoot, normalizedFilePath);
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
          error: error instanceof Error ? error.message : "Failed to load file",
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
        showDesktopWebScrollbar={showDesktopWebScrollbar}
        isMobile={isMobile}
        filePath={filePath}
        imagePreviewUri={imagePreviewUri}
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
