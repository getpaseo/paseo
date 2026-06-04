import React, { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import Markdown, {
  type ASTNode,
  MarkdownIt,
  type RenderRules,
} from "react-native-markdown-display";
import {
  ActivityIndicator,
  Image as RNImage,
  Linking,
  ScrollView as RNScrollView,
  Text,
  type TextProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { MarkdownParagraphView, MarkdownTextSpan } from "@/components/markdown-text";
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
import { isWeb } from "@/constants/platform";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { getMarkdownListMarker, getMarkdownListSpacing } from "@/utils/markdown-list";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

interface CodeLineProps {
  tokens: HighlightToken[];
  lineNumber: number;
  gutterWidth: number;
  highlighted: boolean;
}

interface FilePreviewBodyProps {
  preview: ExplorerFile | null;
  isLoading: boolean;
  showDesktopWebScrollbar: boolean;
  isMobile: boolean;
  location: WorkspaceFileLocation;
  imagePreviewUri: string | null;
}

type MarkdownStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

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

interface MarkdownInheritedTextProps {
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  style?: TextStyle;
  monoSurface?: boolean;
  onPress?: TextProps["onPress"];
  accessibilityRole?: TextProps["accessibilityRole"];
  children: ReactNode;
}

function MarkdownInheritedText({
  inheritedStyles,
  textStyle,
  style: overrideStyle,
  monoSurface,
  onPress,
  accessibilityRole,
  children,
}: MarkdownInheritedTextProps) {
  const style = useMemo(
    () => [inheritedStyles, textStyle, overrideStyle],
    [inheritedStyles, textStyle, overrideStyle],
  );
  return (
    <MarkdownTextSpan
      monoSurface={monoSurface}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      style={style}
    >
      {children}
    </MarkdownTextSpan>
  );
}

interface MarkdownListItemContentProps {
  contentStyle: ViewStyle;
  children: ReactNode;
}

const MARKDOWN_LIST_ITEM_CONTENT_FLEX: ViewStyle = { flex: 1, flexShrink: 1, minWidth: 0 };
const EMPTY_TEXT_STYLE: TextStyle = {};

function MarkdownListItemContent({ contentStyle, children }: MarkdownListItemContentProps) {
  const style = useMemo(() => [contentStyle, MARKDOWN_LIST_ITEM_CONTENT_FLEX], [contentStyle]);
  return <View style={style}>{children}</View>;
}

interface MarkdownListViewProps {
  baseStyle: ViewStyle;
  spacing: { marginTop: number; marginBottom: number };
  children: ReactNode;
}

function MarkdownListView({ baseStyle, spacing, children }: MarkdownListViewProps) {
  const style = useMemo(() => [baseStyle, spacing], [baseStyle, spacing]);
  return <View style={style}>{children}</View>;
}

interface FilePreviewMarkdownLinkProps {
  href: string;
  inheritedStyles: TextStyle;
  linkStyle: TextStyle;
  onLinkPress?: (url: string) => boolean;
  children: ReactNode;
}

function FilePreviewMarkdownLink({
  href,
  inheritedStyles,
  linkStyle,
  onLinkPress,
  children,
}: FilePreviewMarkdownLinkProps) {
  const handlePress = useCallback(() => {
    if (!href) return;
    if (onLinkPress?.(href) === false) return;
    void Linking.openURL(href);
  }, [href, onLinkPress]);

  return (
    <MarkdownInheritedText
      inheritedStyles={inheritedStyles}
      textStyle={linkStyle}
      accessibilityRole="link"
      onPress={handlePress}
    >
      {children}
    </MarkdownInheritedText>
  );
}

function getMarkdownLinkHref(node: ASTNode): string {
  const href = node.attributes?.href;
  return typeof href === "string" ? href : "";
}

function createFilePreviewMarkdownRules(): RenderRules {
  return {
    text: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.text}
      >
        {node.content}
      </MarkdownInheritedText>
    ),
    textgroup: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.textgroup}
      >
        {children}
      </MarkdownInheritedText>
    ),
    strong: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.strong}
      >
        {children}
      </MarkdownInheritedText>
    ),
    em: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText key={node.key} inheritedStyles={inheritedStyles} textStyle={styles.em}>
        {children}
      </MarkdownInheritedText>
    ),
    s: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText key={node.key} inheritedStyles={inheritedStyles} textStyle={styles.s}>
        {children}
      </MarkdownInheritedText>
    ),
    hardbreak: (node: ASTNode) => <MarkdownTextSpan key={node.key}>{"\n"}</MarkdownTextSpan>,
    softbreak: (node: ASTNode) => <MarkdownTextSpan key={node.key}>{"\n"}</MarkdownTextSpan>,
    code_block: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
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
    fence: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
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
    code_inline: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.code_inline}
        monoSurface
      >
        {node.content ?? ""}
      </MarkdownInheritedText>
    ),
    bullet_list: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownListView
        key={node.key}
        baseStyle={styles.bullet_list}
        spacing={getMarkdownListSpacing(node, parent)}
      >
        {children}
      </MarkdownListView>
    ),
    ordered_list: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownListView
        key={node.key}
        baseStyle={styles.ordered_list}
        spacing={getMarkdownListSpacing(node, parent)}
      >
        {children}
      </MarkdownListView>
    ),
    list_item: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => {
      const { isOrdered, marker } = getMarkdownListMarker(node, parent);
      const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
      const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={iconStyle}>{marker}</Text>
          <MarkdownListItemContent contentStyle={contentStyle}>{children}</MarkdownListItemContent>
        </View>
      );
    },
    paragraph: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownParagraphView key={node.key} paragraphStyle={styles.paragraph}>
        {children}
      </MarkdownParagraphView>
    ),
    link: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      onLinkPress?: (url: string) => boolean,
    ) => (
      <FilePreviewMarkdownLink
        key={node.key}
        href={getMarkdownLinkHref(node)}
        inheritedStyles={EMPTY_TEXT_STYLE}
        linkStyle={styles.link}
        onLinkPress={onLinkPress}
      >
        {children}
      </FilePreviewMarkdownLink>
    ),
  };
}

const CodeLine = React.memo(function CodeLine({
  tokens,
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
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );
  return (
    <View style={lineStyle}>
      <View style={gutterStyle}>
        <Text numberOfLines={1} style={codeLineStyles.gutterText}>
          {String(lineNumber)}
        </Text>
      </View>
      <Text selectable style={codeLineStyles.lineText}>
        {keyedTokens.map(({ key, token }) => (
          <CodeLineToken key={key} token={token} />
        ))}
      </Text>
    </View>
  );
});

interface CodeLineTokenProps {
  token: HighlightToken;
}

function CodeLineToken({ token }: CodeLineTokenProps) {
  return <Text style={syntaxTokenStyleFor(token.style)}>{token.text}</Text>;
}

const codeLineStyles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
  },
  highlightedLine: {
    backgroundColor: theme.colors.accentBorder,
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
  const markdownRules = useMemo(() => createFilePreviewMarkdownRules(), []);
  const isMarkdownFile =
    preview?.kind === "text" && isRenderedMarkdownFile(filePath) && !location.lineStart;

  const previewScrollRef = useRef<RNScrollView>(null);
  const webScrollbarStyle = useWebScrollbarStyle();
  const scrollbar = useWebScrollViewScrollbar(previewScrollRef, {
    enabled: showDesktopWebScrollbar,
  });

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
            <AppearanceStyleBoundary>
              <Markdown style={markdownStyles} rules={markdownRules} markdownit={markdownParser}>
                {preview.content ?? ""}
              </Markdown>
            </AppearanceStyleBoundary>
          </RNScrollView>
          {scrollbar.overlay}
        </View>
      );
    }

    const lines = highlightedLines ?? [[{ text: preview.content ?? "", style: null }]];
    const keyedLines = lines.map((tokens, index) => ({
      key: `line-${index}`,
      tokens,
      lineNumber: index + 1,
    }));
    const codeLines = (
      <View dataSet={CODE_SURFACE_DATASET}>
        {keyedLines.map(({ key, tokens, lineNumber }) => (
          <CodeLine
            key={key}
            tokens={tokens}
            lineNumber={lineNumber}
            gutterWidth={gutterWidth}
            highlighted={
              Boolean(lineSelection) &&
              lineNumber >= (lineSelection?.lineStart ?? 0) &&
              lineNumber <= (lineSelection?.lineEnd ?? 0)
            }
          />
        ))}
      </View>
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
      </View>
    );
  }

  if (preview.kind === "image") {
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
