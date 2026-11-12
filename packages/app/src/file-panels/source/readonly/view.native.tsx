import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FlatList,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { FilePanelLoading } from "../../loading";
import type { SourcePresentation } from "./presentation";
import { buildSourceLines } from "./source-lines";
import { anchorScrollOffset } from "@/text-zoom/live";
import { sourceLineMetrics, type SourceLineMetrics } from "./line-metrics";
import { useScopedTextZoom } from "@/text-zoom/scope";
import { getTextZoomPinch } from "@/text-zoom/store";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  presentation: Exclude<SourcePresentation, "unsupported">;
  theme: EditorVisualTheme;
}

/** Lines past the opening line highlighted before the rest of a large file. */
const FIRST_LINES = 200;

/**
 * A virtualized, read-only source view. Shows Loading until the lines around the opening line are
 * highlighted; the rest highlight in the background. A changed file keeps showing the previous
 * lines until its own are ready.
 */
export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  theme,
}: FileSourceViewProps) {
  const listRef = useRef<FlatList<HighlightToken[]>>(null);
  const frameRef = useRef<View>(null);
  const zoom = useScopedTextZoom();
  const { fontSize, lineHeight, gutterWidth } = sourceLineMetrics(theme.codeFontSize, zoom);
  const metrics = useRef<SourceLineMetrics>({ fontSize, lineHeight, gutterWidth });
  const scrollOffset = useRef(0);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
  }, []);
  // A pinch changes the row height; keep the line under the fingers where it was.
  useLayoutEffect(() => {
    const previous = metrics.current.lineHeight;
    metrics.current = { fontSize, lineHeight, gutterWidth };
    if (previous === lineHeight) return;
    const scrollTo = (focalY: number) => {
      const offset = anchorScrollOffset({
        offset: scrollOffset.current,
        focalY,
        fromScale: previous,
        toScale: lineHeight,
      });
      scrollOffset.current = offset;
      listRef.current?.scrollToOffset({ offset, animated: false });
    };
    const focal = getTextZoomPinch()?.focal;
    if (!focal) {
      scrollTo(0);
      return;
    }
    frameRef.current?.measureInWindow((_x, y) => scrollTo(Math.max(0, focal.y - y)));
  }, [fontSize, gutterWidth, lineHeight]);
  const getItemLayout = useCallback(
    (_data: ArrayLike<HighlightToken[]> | null | undefined, index: number) => ({
      length: lineHeight,
      offset: index * lineHeight,
      index,
    }),
    [lineHeight],
  );
  const renderSourceLine = useCallback<ListRenderItem<HighlightToken[]>>(
    ({ item, index }) => (
      <SourceLineView
        tokens={item}
        number={index + 1}
        fontSize={fontSize}
        lineHeight={lineHeight}
        gutterWidth={gutterWidth}
      />
    ),
    [fontSize, gutterWidth, lineHeight],
  );
  const [lines, setLines] = useState<HighlightToken[][] | null>(null);
  // Navigating within the file does not rebuild its lines; a new build starts at the latest line.
  const openingLine = useRef(location.lineStart);
  useEffect(() => {
    openingLine.current = location.lineStart;
  });
  useEffect(() => {
    const firstLines = (openingLine.current ?? 1) + FIRST_LINES;
    return buildSourceLines({ content, filename, presentation, firstLines }, setLines);
  }, [content, filename, presentation]);
  const lineCount = lines?.length ?? 0;
  useEffect(() => {
    if (!location.lineStart || lineCount === 0) return;
    listRef.current?.scrollToIndex({
      index: Math.min(location.lineStart - 1, lineCount - 1),
      animated: false,
      viewPosition: 0.5,
    });
  }, [lineCount, location.lineStart, navigationRevision]);
  if (!lines) return <FilePanelLoading />;
  return (
    <View ref={frameRef} collapsable={false} style={styles.frame}>
      <FlatList
        ref={listRef}
        data={lines}
        extraData={lineHeight}
        keyExtractor={sourceLineKey}
        initialNumToRender={24}
        windowSize={9}
        getItemLayout={getItemLayout}
        renderItem={renderSourceLine}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      />
    </View>
  );
}

interface SourceLineProps extends SourceLineMetrics {
  tokens: HighlightToken[];
  number: number;
}

// Finishing the highlight replaces every line; the lines already highlighted stay as they were.
const SourceLineView = memo(function SourceLineView({
  tokens,
  number,
  fontSize,
  lineHeight,
  gutterWidth,
}: SourceLineProps) {
  // A token's offset in its line identifies it; its text and style can repeat.
  let offset = 0;
  return (
    <View style={styles.line(lineHeight)}>
      <Text style={styles.gutter(fontSize, lineHeight, gutterWidth)}>{number}</Text>
      <Text selectable style={styles.text(fontSize, lineHeight)}>
        {tokens.map((token) => {
          const key = offset;
          offset += token.text.length;
          return (
            <Text key={key} style={syntaxTokenStyleFor(token.style)}>
              {token.text}
            </Text>
          );
        })}
      </Text>
    </View>
  );
}, sameSourceLine);

function sameSourceLine(previous: SourceLineProps, next: SourceLineProps): boolean {
  return (
    previous.number === next.number &&
    previous.fontSize === next.fontSize &&
    previous.lineHeight === next.lineHeight &&
    previous.gutterWidth === next.gutterWidth &&
    previous.tokens.length === next.tokens.length &&
    previous.tokens.every(
      (token, index) =>
        token.text === next.tokens[index].text && token.style === next.tokens[index].style,
    )
  );
}

function sourceLineKey(_tokens: HighlightToken[], index: number): string {
  return String(index);
}

// Sizes come from the text zoom, so rows, line numbers and getItemLayout share one line height.
const styles = StyleSheet.create((theme) => ({
  frame: { flex: 1 },
  line: (lineHeight: number) => ({ flexDirection: "row", minHeight: lineHeight }),
  gutter: (fontSize: number, lineHeight: number, gutterWidth: number) => ({
    width: gutterWidth,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize,
    lineHeight,
  }),
  text: (fontSize: number, lineHeight: number) => ({
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize,
    lineHeight,
  }),
}));
