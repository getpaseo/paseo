import { useMemo } from "react";
import { Text, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@/git/use-diff-query";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { isNative } from "@/constants/platform";

// Shared per-line content renderer for diff surfaces. Both the Changes view
// (diff-pane.tsx) and the per-commit file diff (commit-file-diff-view.tsx) use
// this so syntax highlighting, font metrics, and wrap behavior stay identical.
// Falls back to plain content text upstream when `tokens` is absent/empty.

interface HighlightedTextProps {
  tokens: HighlightToken[];
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

function HighlightedToken({ token }: { token: HighlightToken }) {
  return <Text style={syntaxTokenStyleFor(token.style)}>{token.text}</Text>;
}

export function HighlightedText({ tokens, wrapLines = false, testID }: HighlightedTextProps) {
  const containerStyle = useMemo(
    () => [styles.diffTextMetrics, styles.diffLineText, getWrappedTextStyle(wrapLines)],
    [wrapLines],
  );

  const keyedTokens = useMemo(
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );

  return (
    <Text style={containerStyle} testID={testID}>
      {keyedTokens.map(({ key, token }) => (
        <HighlightedToken key={key} token={token} />
      ))}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  diffTextMetrics: {
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
  },
  diffLineText: {
    flex: 1,
    paddingRight: theme.spacing[3],
    color: theme.colors.foreground,
    userSelect: "text",
  },
}));
