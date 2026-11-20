import { memo, useEffect, useRef, useState } from "react";
import { FlatList, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { FilePanelLoading } from "../../loading";
import type { SourcePresentation } from "./presentation";
import { buildSourceLines } from "./source-lines";

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
}: FileSourceViewProps) {
  const listRef = useRef<FlatList<HighlightToken[]>>(null);
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
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={sourceLineKey}
      initialNumToRender={24}
      windowSize={9}
      getItemLayout={sourceLineLayout}
      renderItem={renderSourceLine}
    />
  );
}

interface SourceLineProps {
  tokens: HighlightToken[];
  number: number;
}

// Finishing the highlight replaces every line; the lines already highlighted stay as they were.
const SourceLineView = memo(function SourceLineView({ tokens, number }: SourceLineProps) {
  // A token's offset in its line identifies it; its text and style can repeat.
  let offset = 0;
  return (
    <View style={styles.line}>
      <Text style={styles.gutter}>{number}</Text>
      <Text selectable style={styles.text}>
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

function sourceLineLayout(_data: ArrayLike<HighlightToken[]> | null | undefined, index: number) {
  return { length: 20, offset: index * 20, index };
}

const renderSourceLine: ListRenderItem<HighlightToken[]> = ({ item, index }) => (
  <SourceLineView tokens={item} number={index + 1} />
);

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: "row", minHeight: theme.fontSize.code * 1.45 },
  gutter: {
    width: 56,
    paddingRight: theme.spacing[3],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  text: {
    flex: 1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.45,
  },
}));
