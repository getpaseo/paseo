import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, PixelRatio, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { selectSourcePresentation } from "./presentation";
import { sourceRowOffsets } from "./row-layout";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
}

interface SourceLine {
  number: number;
  tokens: HighlightToken[];
  /** The line's own text, which decides how many visual lines its row occupies. */
  text: string;
}

export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  size,
  theme,
  tooLargeMessage,
}: FileSourceViewProps) {
  const presentation = selectSourcePresentation({ size, platform: "native" });
  if (presentation === "unsupported") {
    return (
      <View style={styles.unsupported} testID="file-source-too-large">
        <Text style={styles.unsupportedText}>{tooLargeMessage}</Text>
      </View>
    );
  }
  return (
    <VirtualizedSource
      content={content}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      presentation={presentation}
      codeFontSize={theme.codeFontSize}
    />
  );
}

function VirtualizedSource({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  codeFontSize,
}: Omit<FileSourceViewProps, "size" | "theme" | "tooLargeMessage"> & {
  presentation: "highlighted" | "plain";
  codeFontSize: number;
}) {
  const { t } = useTranslation();
  const listRef = useRef<FlatList<SourceLine>>(null);
  const lines = useMemo(() => {
    const source = content.replace(/\r\n?/g, "\n");
    if (presentation === "highlighted")
      return highlightCode(source, filename).map((tokens, index) => ({
        number: index + 1,
        tokens,
        text: tokens.map((token) => token.text).join(""),
      }));
    return source.split("\n").map((text, index) => ({
      number: index + 1,
      tokens: [{ text, style: null }],
      text,
    }));
  }, [content, filename, presentation]);
  // Jumping to a match thousands of lines in only works if the list is told the truth about row
  // heights. A row is one visual line at the reader's own code size, rounded the way the device
  // rounds it, times however many visual lines the text wraps onto. Assuming one line per row put
  // a match in an ordinary source file hundreds of lines off screen, because ordinary lines wrap.
  const [columnWidth, setColumnWidth] = useState(0);
  const [listWidth, setListWidth] = useState(0);
  const visualLineHeight = PixelRatio.roundToNearestPixel(sourceRowHeight(codeFontSize));
  const columns =
    columnWidth > 0 && listWidth > 0
      ? Math.max(1, Math.floor((listWidth - GUTTER_WIDTH) / columnWidth))
      : 0;
  const offsets = useMemo(
    () => sourceRowOffsets(lines, { columns, visualLineHeight }),
    [columns, lines, visualLineHeight],
  );
  const itemLayout = useCallback(
    (_data: ArrayLike<SourceLine> | null | undefined, index: number) => ({
      length: offsets[index + 1] - offsets[index],
      offset: offsets[index],
      index,
    }),
    [offsets],
  );
  const measureColumn = useCallback(
    (event: LayoutChangeEvent) =>
      setColumnWidth(event.nativeEvent.layout.width / COLUMN_PROBE.length),
    [],
  );
  const measureList = useCallback(
    (event: LayoutChangeEvent) => setListWidth(event.nativeEvent.layout.width),
    [],
  );
  useEffect(() => {
    if (!location.lineStart) return;
    listRef.current?.scrollToIndex({
      index: Math.min(location.lineStart - 1, lines.length - 1),
      animated: false,
      // Near the top with a little context above, rather than centred: centring is measured
      // against the list's own box, which inside a sheet is taller than the part on screen.
      viewPosition: 0,
      viewOffset: visualLineHeight * CONTEXT_LINES_ABOVE_MATCH,
    });
  }, [lines.length, location.lineStart, navigationRevision, offsets, visualLineHeight]);
  const selectedLine = lines[(location.lineStart ?? 1) - 1]?.tokens
    .map((token) => token.text)
    .join("");
  const changed =
    location.expectedText !== undefined &&
    selectedLine?.slice((location.columnStart ?? 1) - 1, (location.columnEnd ?? 1) - 1) !==
      location.expectedText;
  const renderLine = useCallback(
    ({ item }: { item: SourceLine }) => (
      <SourceLineView
        line={item}
        start={!changed && item.number === location.lineStart ? location.columnStart : undefined}
        end={!changed && item.number === location.lineStart ? location.columnEnd : undefined}
      />
    ),
    [changed, location],
  );
  return (
    <View style={styles.root} onLayout={measureList}>
      <Text aria-hidden style={styles.columnProbe} onLayout={measureColumn}>
        {COLUMN_PROBE}
      </Text>
      {changed ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {t("shell.commandCenter.contentChanged")}
        </Text>
      ) : null}
      {columns > 0 ? (
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={sourceLineKey}
          initialNumToRender={24}
          windowSize={9}
          extraData={location}
          getItemLayout={itemLayout}
          renderItem={renderLine}
        />
      ) : null}
    </View>
  );
}

function SourceLineView({ line, start, end }: { line: SourceLine; start?: number; end?: number }) {
  let offset = 0;
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{line.number}</Text>
      <Text selectable style={styles.text}>
        {line.tokens.map((token) => {
          const tokenStart = offset;
          offset += token.text.length;
          const from = Math.max(0, Math.min(token.text.length, (start ?? 1) - 1 - tokenStart));
          const to = Math.max(from, Math.min(token.text.length, (end ?? 1) - 1 - tokenStart));
          return (
            <Text key={`${tokenStart}:${token.style}`} style={syntaxTokenStyleFor(token.style)}>
              {token.text.slice(0, from)}
              <Text style={styles.match}>{token.text.slice(from, to)}</Text>
              {token.text.slice(to)}
            </Text>
          );
        })}
      </Text>
    </View>
  );
}

function sourceLineKey(line: SourceLine): string {
  return String(line.number);
}

/** One visual line of code; the stylesheet below builds its row from the same ratio. */
function sourceRowHeight(codeFontSize: number): number {
  return codeFontSize * SOURCE_LINE_RATIO;
}

const SOURCE_LINE_RATIO = 1.45;
const GUTTER_WIDTH = 56;
/** Measured once to learn how wide one monospace character is at the reader's code size. */
const COLUMN_PROBE = "0".repeat(10);
const CONTEXT_LINES_ABOVE_MATCH = 2;

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  notice: {
    padding: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  match: { backgroundColor: theme.colors.terminal.selectionBackground },
  unsupported: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
  line: { flexDirection: "row", minHeight: sourceRowHeight(theme.fontSize.code) },
  gutter: {
    width: GUTTER_WIDTH,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  columnProbe: {
    position: "absolute",
    opacity: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  text: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: sourceRowHeight(theme.fontSize.code),
  },
}));
