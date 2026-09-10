import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FlatList, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { selectSourcePresentation } from "./presentation";

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
      }));
    return source
      .split("\n")
      .map((text, index) => ({ number: index + 1, tokens: [{ text, style: null }] }));
  }, [content, filename, presentation]);
  // A row is exactly one line of code at the reader's own code size, so the list can jump straight
  // to a match thousands of lines in. Hard-coding this height instead of deriving it left every
  // reader who changed their code size looking at the wrong part of the file.
  const rowHeight = sourceRowHeight(codeFontSize);
  const itemLayout = useCallback(
    (_data: ArrayLike<SourceLine> | null | undefined, index: number) => ({
      length: rowHeight,
      offset: index * rowHeight,
      index,
    }),
    [rowHeight],
  );
  useEffect(() => {
    if (!location.lineStart) return;
    listRef.current?.scrollToIndex({
      index: Math.min(location.lineStart - 1, lines.length - 1),
      animated: false,
      viewPosition: 0.5,
    });
  }, [lines.length, location.lineStart, navigationRevision]);
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
    <View style={styles.root}>
      {changed ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {t("shell.commandCenter.contentChanged")}
        </Text>
      ) : null}
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

/** One rendered code line; the stylesheet below builds its row from the same ratio. */
function sourceRowHeight(codeFontSize: number): number {
  return codeFontSize * SOURCE_LINE_RATIO;
}

const SOURCE_LINE_RATIO = 1.45;

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
    lineHeight: sourceRowHeight(theme.fontSize.code),
  },
}));
