import React from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import { isWeb } from "@/constants/platform";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import type { KeyedLine, KeyedToken } from "@/utils/highlight-cache";

// Line height kept in sync with the plain `scrollText` style in
// tool-call-details so a highlighted block lines up with an unhighlighted
// fallback and blank lines keep their height.
const CODE_LINE_HEIGHT = 18;
const ZERO_WIDTH = "​";

interface HighlightedLinesProps {
  lines: KeyedLine[];
  // 1-based line number of the first line; when set, a line-number gutter is
  // rendered (used by Read, which carries a server-normalized offset).
  startLine?: number;
}

function ContentLine({ line }: { line: KeyedLine }) {
  return (
    <Text selectable style={styles.lineText}>
      {line.tokens.length === 0
        ? ZERO_WIDTH
        : line.tokens.map(({ key, token }: KeyedToken) => (
            <Text key={key} style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
              {token.text}
            </Text>
          ))}
    </Text>
  );
}

const GutteredLine = React.memo(function GutteredLine({
  line,
  lineNumber,
  digits,
}: {
  line: KeyedLine;
  lineNumber: number;
  digits: number;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.gutterText}>{String(lineNumber).padStart(digits)} </Text>
      <ContentLine line={line} />
    </View>
  );
});

// Renders pre-tokenized lines (from the shared highlight cache), optionally with
// a line-number gutter. Callers decide whether to highlight at all, so the
// expensive size-cap / unsupported-language fallback stays a single plain Text.
export function HighlightedLines({ lines, startLine }: HighlightedLinesProps) {
  if (startLine === undefined) {
    return (
      <View>
        {lines.map((line) => (
          <ContentLine key={line.key} line={line} />
        ))}
      </View>
    );
  }

  const lastLineNumber = startLine + lines.length - 1;
  const digits = Math.max(2, String(lastLineNumber).length);
  return (
    <View>
      {lines.map((line, index) => (
        <GutteredLine key={line.key} line={line} lineNumber={startLine + index} digits={digits} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    minHeight: CODE_LINE_HEIGHT,
  },
  gutterText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.code,
    lineHeight: CODE_LINE_HEIGHT,
    color: theme.colors.foregroundMuted,
    opacity: 0.6,
    userSelect: "none",
    flexShrink: 0,
  },
  lineText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    lineHeight: CODE_LINE_HEIGHT,
    ...(isWeb
      ? {
          whiteSpace: "pre",
          overflowWrap: "normal",
        }
      : null),
  },
}));
