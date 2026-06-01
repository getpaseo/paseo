import React, { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import Markdown, {
  MarkdownIt,
  type ASTNode,
  type RenderRules,
} from "react-native-markdown-display";
import {
  ActivityIndicator,
  Image as RNImage,
  ScrollView as RNScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore, type ExplorerFile } from "@/stores/session-store";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import { isNative, isWeb } from "@/constants/platform";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { MarkdownParagraphView, MarkdownTextSpan } from "@/components/markdown-text";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

type FileMarkdownStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

// Native horizontal code scroll uses gesture-handler's ScrollView (matching
// DiffViewer / DiffScroll) so the inner horizontal scroller hands vertical
// drags back to the outer ScrollView on Android; web keeps the RN ScrollView.
const CodeHorizontalScrollView = isWeb ? RNScrollView : GHScrollView;

// Round the line box so the separate gutter <Text> rows and the single code
// body share an integer row height — sub-pixel drift (fontSize * 1.45) would
// otherwise accumulate differently between the two columns per platform.
const codeLineHeight = (fontSizeCode: number) => Math.round(fontSizeCode * 1.45);

// Above this size a Markdown file is NOT rendered. The rendered path emits one
// UITextView per block (paragraph / heading / list item); a large document
// spawns hundreds and iOS OOM-kills the app. Instead it falls back to a plain
// <Text> source view — a single lightweight UILabel that the system pages
// efficiently and never OOMs. Selection degrades to whole-content copy there.
// Conservative on purpose: prose docs trip this well before the OOM cliff.
const LARGE_MARKDOWN_CHARS = 15_000;
// Hard cap for the plain-text fallback so a pathological multi-MB file can't
// stall text layout; beyond this the preview shows a truncation note.
const MAX_PLAIN_PREVIEW_CHARS = 200_000;
// Even below LARGE_MARKDOWN_CHARS, cap how many top-level blocks the rendered
// path will mount (each ≈ one UITextView) as a second safety net.
const MAX_MARKDOWN_TOP_LEVEL_CHILDREN = 150;

// react-native-markdown-display's exported types omit maxTopLevelChildren even
// though it's a real runtime prop (see node_modules/.../src/index.js). Cast to
// surface it, the same way message.tsx wraps the component for its own props.
const FileMarkdown = Markdown as React.ComponentType<{
  style?: unknown;
  markdownit?: unknown;
  rules?: RenderRules;
  maxTopLevelChildren?: number;
  children?: ReactNode;
}>;

// Wraps MarkdownTextSpan so the [inherited, style] array is memoized inside a
// component (react-perf/jsx-no-new-array-as-prop) rather than built inline in
// each rule callback.
function FileMarkdownSpan({
  inheritedStyles,
  textStyle,
  monoSurface,
  children,
}: {
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  monoSurface?: boolean;
  children: ReactNode;
}) {
  const style = useMemo(() => [inheritedStyles, textStyle], [inheritedStyles, textStyle]);
  return (
    <MarkdownTextSpan monoSurface={monoSurface} style={style}>
      {children}
    </MarkdownTextSpan>
  );
}

// .md previews reuse the assistant-message selectable-markdown building blocks
// (MarkdownTextSpan / MarkdownParagraphView are UITextView-backed on iOS) so a
// rendered Markdown file gets the same native word-selection. Only the rules
// that would otherwise emit a non-selectable <Text>/UILabel are overridden;
// headings, lists and blockquotes inherit selectability via the overridden
// `text` / `textgroup`.
const fileMarkdownRules: RenderRules = {
  text: (
    node: ASTNode,
    _children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
    inheritedStyles: TextStyle = {},
  ) => (
    <FileMarkdownSpan key={node.key} inheritedStyles={inheritedStyles} textStyle={styles.text}>
      {node.content}
    </FileMarkdownSpan>
  ),
  textgroup: (
    node: ASTNode,
    children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
  ) => (
    <MarkdownTextSpan key={node.key} style={styles.textgroup}>
      {children}
    </MarkdownTextSpan>
  ),
  paragraph: (
    node: ASTNode,
    children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
  ) => (
    <MarkdownParagraphView key={node.key} paragraphStyle={styles.paragraph}>
      {children}
    </MarkdownParagraphView>
  ),
  code_inline: (
    node: ASTNode,
    _children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
    inheritedStyles: TextStyle = {},
  ) => (
    <FileMarkdownSpan
      key={node.key}
      inheritedStyles={inheritedStyles}
      textStyle={styles.code_inline}
      monoSurface
    >
      {node.content}
    </FileMarkdownSpan>
  ),
  fence: (
    node: ASTNode,
    _children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
    inheritedStyles: TextStyle = {},
  ) => (
    <HighlightedCodeBlock
      key={node.key}
      code={node.content}
      language={node.sourceInfo}
      inheritedStyles={inheritedStyles}
      textStyle={styles.fence}
    />
  ),
  code_block: (
    node: ASTNode,
    _children: ReactNode[],
    _parent: ASTNode[],
    styles: FileMarkdownStyles,
    inheritedStyles: TextStyle = {},
  ) => (
    <HighlightedCodeBlock
      key={node.key}
      code={node.content}
      language={null}
      inheritedStyles={inheritedStyles}
      textStyle={styles.code_block}
    />
  ),
  link: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: FileMarkdownStyles) => (
    // Render link text as a plain selectable span (no navigation). The default
    // link rule calls openURL on tap, which is undesirable in a read-only file
    // preview; a span keeps the link text selectable/copyable like the rest.
    <MarkdownTextSpan key={node.key} style={styles.link}>
      {children}
    </MarkdownTextSpan>
  ),
};

interface CodeKeyedLine {
  key: string;
  tokens: HighlightToken[];
  lineNumber: number;
}

interface CodeBodyProps {
  keyedLines: CodeKeyedLine[];
  gutterWidth: number;
  lineHeight: number;
  lineSelection: FileLineSelection | null;
}

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  isLoading: boolean;
  showDesktopWebScrollbar: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  imagePreviewUri: string | null;
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

// The whole file renders as ONE UITextView (via MarkdownTextSpan) so iOS
// selection drags can span multiple lines — sibling native text views can't be
// selected across. Line numbers live in a separate gutter column (userSelect:
// none so they never end up in the copied text), and the file:line jump
// highlight is an absolutely-positioned overlay behind the text. This relies on
// code NOT wrapping (horizontal scroll) so every line is exactly lineHeight
// tall and the gutter / overlay stay aligned by row index.
const CodeBody = React.memo(function CodeBody({
  keyedLines,
  gutterWidth,
  lineHeight,
  lineSelection,
}: CodeBodyProps) {
  const gutterStyle = useMemo(
    () => [codeStyles.gutter, inlineUnistylesStyle({ width: gutterWidth })],
    [gutterWidth],
  );
  const highlightStyle = useMemo(() => {
    if (!lineSelection) return null;
    return [
      codeStyles.lineHighlight,
      inlineUnistylesStyle({
        top: (lineSelection.lineStart - 1) * lineHeight,
        height: (lineSelection.lineEnd - lineSelection.lineStart + 1) * lineHeight,
      }),
    ];
  }, [lineSelection, lineHeight]);
  return (
    <View dataSet={CODE_SURFACE_DATASET} style={codeStyles.surface}>
      {highlightStyle ? <View pointerEvents="none" style={highlightStyle} /> : null}
      <View style={codeStyles.row}>
        <View style={gutterStyle}>
          {keyedLines.map(({ key, lineNumber }) => (
            <Text key={key} numberOfLines={1} style={codeStyles.gutterText}>
              {String(lineNumber)}
            </Text>
          ))}
        </View>
        <MarkdownTextSpan monoSurface style={codeStyles.codeText}>
          {renderCodeFileSegments(keyedLines)}
        </MarkdownTextSpan>
      </View>
    </View>
  );
});

// Flattens every line's tokens into one stream, joining lines with "\n" so the
// single UITextView lays them out as separate visual rows. Mirrors the segment
// approach in HighlightedCodeBlock.
function renderCodeFileSegments(keyedLines: CodeKeyedLine[]): ReactNode[] {
  const segments: ReactNode[] = [];
  keyedLines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      segments.push(<MarkdownTextSpan key={`${line.key}-nl`}>{"\n"}</MarkdownTextSpan>);
    }
    // Key by column offset (data-dependent, unique within a line) rather than
    // the array index, which the no-array-index-key rule forbids.
    let col = 0;
    for (const token of line.tokens) {
      const segmentKey = `${line.key}-c${col}`;
      col += token.text.length;
      segments.push(
        <MarkdownTextSpan
          key={segmentKey}
          style={token.style ? syntaxTokenStyleFor(token.style) : undefined}
        >
          {token.text}
        </MarkdownTextSpan>,
      );
    }
  });
  return segments;
}

const codeStyles = StyleSheet.create((theme) => ({
  surface: {
    position: "relative",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
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
    lineHeight: codeLineHeight(theme.fontSize.code),
    opacity: 0.4,
    userSelect: "none",
  },
  codeText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: codeLineHeight(theme.fontSize.code),
    color: theme.colors.foreground,
    // Must not be shrunk/wrapped by the parent flex row: the body has to take
    // its natural width and overflow the horizontal scroll, otherwise a line
    // wider than the viewport wraps and desyncs the gutter column + the
    // absolute highlight overlay (which assume one fixed-height row per line).
    // On web, base Text defaults to whiteSpace:pre-wrap, so force `pre`; also
    // opt into text selection since the web MarkdownTextSpan is a plain Text.
    flexShrink: 0,
    ...(isWeb ? { whiteSpace: "pre", overflowWrap: "normal", userSelect: "text" } : null),
  },
  lineHighlight: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: theme.colors.accentBorder,
  },
}));

function ImagePreview({
  imageSource,
  imagePreviewUri,
  previewScrollRef,
  scrollbar,
  showDesktopWebScrollbar,
}: {
  imageSource: { uri: string } | null;
  imagePreviewUri: string | null;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  scrollbar: ReturnType<typeof useWebScrollViewScrollbar>;
  showDesktopWebScrollbar: boolean;
}) {
  if (!imagePreviewUri) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>Loading file…</Text>
      </View>
    );
  }
  return (
    <View style={styles.previewScrollContainer}>
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
    </View>
  );
}

// Rendered Markdown preview (small/medium docs, all platforms; large native
// docs use LargeSourcePreview instead). maxTopLevelChildren caps blocks on
// native as an OOM safety net; web/desktop render to the DOM unbounded.
function RenderedMarkdownPreview({
  content,
  markdownStyles,
  markdownParser,
  previewScrollRef,
  scrollbar,
  showDesktopWebScrollbar,
}: {
  content: string;
  markdownStyles: unknown;
  markdownParser: unknown;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  scrollbar: ReturnType<typeof useWebScrollViewScrollbar>;
  showDesktopWebScrollbar: boolean;
}) {
  return (
    <View style={styles.previewScrollContainer}>
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
        <FileMarkdown
          style={markdownStyles}
          markdownit={markdownParser}
          rules={fileMarkdownRules}
          maxTopLevelChildren={isNative ? MAX_MARKDOWN_TOP_LEVEL_CHILDREN : undefined}
        >
          {content}
        </FileMarkdown>
      </RNScrollView>
      {scrollbar.overlay}
    </View>
  );
}

// Source-view fallback for large Markdown (see LARGE_MARKDOWN_CHARS): one
// UITextView holding the whole file as a single attributed string. Unlike the
// rendered path (one view per block) or the token-highlighted CodeBody (one
// child per token), this is a single native view + one text run, so it stays
// word-selectable (TextKit-paged) without the per-node OOM.
function LargeSourcePreview({
  content,
  previewScrollRef,
  scrollbar,
  showDesktopWebScrollbar,
}: {
  content: string;
  previewScrollRef: React.RefObject<RNScrollView | null>;
  scrollbar: ReturnType<typeof useWebScrollViewScrollbar>;
  showDesktopWebScrollbar: boolean;
}) {
  const truncated = content.length > MAX_PLAIN_PREVIEW_CHARS;
  const shown = truncated ? content.slice(0, MAX_PLAIN_PREVIEW_CHARS) : content;
  return (
    <View style={styles.previewScrollContainer}>
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
        <MarkdownTextSpan style={styles.plainPreviewText}>{shown}</MarkdownTextSpan>
        {truncated ? (
          <Text style={styles.plainPreviewNote}>
            … 文件过大，仅显示前 {Math.round(MAX_PLAIN_PREVIEW_CHARS / 1000)} KB 源码
          </Text>
        ) : null}
      </RNScrollView>
      {scrollbar.overlay}
    </View>
  );
}

function FilePreviewBody({
  preview,
  isLoading,
  showDesktopWebScrollbar,
  isMobile,
  location,
  imagePreviewUri,
}: FilePreviewBodyProps) {
  const { theme } = useUnistyles();
  const filePath = location.path;
  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
  const markdownParser = useMemo(() => MarkdownIt({ typographer: true, linkify: true }), []);
  // OOM from per-block UITextViews is a NATIVE concern (iOS especially; Android
  // ReactTextViews are lighter but still real native views). Web/desktop render
  // to the DOM, which the browser/Chromium handles fine, so only native falls
  // back to the source view. The fallback is ONE UITextView holding the whole
  // source as a single attributed string — still word-selectable, but without
  // the per-block view explosion — and it also surfaces the raw Markdown (#1264).
  const isMarkdownPath = preview?.kind === "text" && isRenderedMarkdownFile(filePath);
  const isLargeMarkdown =
    isNative && isMarkdownPath && (preview?.content ?? "").length > LARGE_MARKDOWN_CHARS;
  const isMarkdownFile = isMarkdownPath && !location.lineStart && !isLargeMarkdown;

  const previewScrollRef = useRef<RNScrollView>(null);
  const webScrollbarStyle = useWebScrollbarStyle();
  const scrollbar = useWebScrollViewScrollbar(previewScrollRef, {
    enabled: showDesktopWebScrollbar,
  });

  const highlightedLines = useMemo(() => {
    if (!preview || preview.kind !== "text" || isMarkdownFile || isLargeMarkdown) {
      return null;
    }

    return highlightCode(preview.content ?? "", filePath);
  }, [isMarkdownFile, isLargeMarkdown, preview, filePath]);

  const gutterWidth = useMemo(() => {
    if (!highlightedLines) return 0;
    return lineNumberGutterWidth(highlightedLines.length, theme.fontSize.code);
  }, [highlightedLines, theme.fontSize.code]);
  const lineHeight = codeLineHeight(theme.fontSize.code);
  const keyedLines = useMemo<CodeKeyedLine[]>(() => {
    const lines = highlightedLines ?? [[{ text: preview?.content ?? "", style: null }]];
    return lines.map((tokens, index) => ({
      key: `line-${index}`,
      tokens,
      lineNumber: index + 1,
    }));
  }, [highlightedLines, preview]);
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
        <Text style={styles.loadingText}>Loading file…</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyText}>No preview available</Text>
      </View>
    );
  }

  if (preview.kind === "text") {
    if (isMarkdownFile) {
      return (
        <RenderedMarkdownPreview
          content={preview.content ?? ""}
          markdownStyles={markdownStyles}
          markdownParser={markdownParser}
          previewScrollRef={previewScrollRef}
          scrollbar={scrollbar}
          showDesktopWebScrollbar={showDesktopWebScrollbar}
        />
      );
    }

    if (isLargeMarkdown) {
      return (
        <LargeSourcePreview
          content={preview.content ?? ""}
          previewScrollRef={previewScrollRef}
          scrollbar={scrollbar}
          showDesktopWebScrollbar={showDesktopWebScrollbar}
        />
      );
    }

    const codeBody = (
      <CodeBody
        keyedLines={keyedLines}
        gutterWidth={gutterWidth}
        lineHeight={lineHeight}
        lineSelection={lineSelection}
      />
    );

    return (
      <View style={styles.previewScrollContainer}>
        <RNScrollView
          ref={previewScrollRef}
          style={styles.previewContent}
          onLayout={scrollbar.onLayout}
          onScroll={scrollbar.onScroll}
          onContentSizeChange={scrollbar.onContentSizeChange}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={!showDesktopWebScrollbar}
        >
          {/* Code is always horizontally scrollable (never wraps) so each line
              stays exactly one row tall — required for gutter/overlay alignment
              and for cross-line selection in the single UITextView. */}
          <CodeHorizontalScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator={!isMobile}
            style={isMobile ? undefined : webScrollbarStyle}
            contentContainerStyle={styles.previewCodeScrollContent}
          >
            {codeBody}
          </CodeHorizontalScrollView>
        </RNScrollView>
        {scrollbar.overlay}
      </View>
    );
  }

  if (preview.kind === "image") {
    return (
      <ImagePreview
        imageSource={imageSource}
        imagePreviewUri={imagePreviewUri}
        previewScrollRef={previewScrollRef}
        scrollbar={scrollbar}
        showDesktopWebScrollbar={showDesktopWebScrollbar}
      />
    );
  }

  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>Binary preview unavailable</Text>
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
  const isMobile = useIsCompactFormFactor();
  const showDesktopWebScrollbar = isWeb && !isMobile;

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

  const query = useQuery({
    queryKey: ["workspaceFile", serverId, readTarget?.cwd ?? null, readTarget?.path ?? null],
    enabled: Boolean(client && readTarget),
    queryFn: async () => {
      if (!client || !readTarget) {
        return { file: null as ExplorerFile | null, error: "Host is not connected" };
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
        location={location}
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
  plainPreviewText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: codeLineHeight(theme.fontSize.code),
    color: theme.colors.foreground,
    ...(isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" } : null),
  },
  plainPreviewNote: {
    marginTop: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
