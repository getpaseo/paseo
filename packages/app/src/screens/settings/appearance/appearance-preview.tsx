import { useMemo } from "react";
import { Text, View, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { DEFAULT_MONO_FONT_STACK } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { tokenizeToLines } from "@/utils/highlight-cache";
import { CHANGED_LINE_INDICES, PREVIEW_AFTER, PREVIEW_BEFORE } from "./preview-snippet";

// Snippets are TypeScript; the cache keys grammar selection off the extension.
const PREVIEW_EXTENSION = "ts";

// GitHub diff tints, matching git/diff-pane.tsx (addLineContainer /
// removeLineContainer). Hardcoded rgba is the documented diff exception to the
// "no raw hex outside the palette" rule (docs/design.md §13).
const REMOVED_TINT = "rgba(248, 81, 73, 0.1)";
const ADDED_TINT = "rgba(46, 160, 67, 0.15)";

// Zero-width space keeps blank lines at full line height, like the canonical
// highlighted-content renderer.
const ZERO_WIDTH = "​";

interface PreviewOverrides {
  monoFontFamily?: string;
  codeFontSize?: number;
}

interface AppearancePreviewProps {
  // Live draft values for the code font applied as inline overrides on top of
  // the themed styles (the while-typing path). Absent/empty fields fall back to
  // the theme value; an explicitly-empty family resolves to the default stack.
  overrides?: PreviewOverrides;
}

// A family override is present when the field exists; "" means "platform
// default", so it resolves to the stack rather than falling through to theme.
function resolveFamilyOverride(value: string | undefined, fallback: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function resolveSizeOverride(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildCodeOverride(overrides: PreviewOverrides | undefined): TextStyle {
  if (!overrides) return {};
  const style: TextStyle = {};
  const fontFamily = resolveFamilyOverride(overrides.monoFontFamily, DEFAULT_MONO_FONT_STACK);
  if (fontFamily !== undefined) style.fontFamily = fontFamily;
  const fontSize = resolveSizeOverride(overrides.codeFontSize);
  if (fontSize !== undefined) {
    style.fontSize = fontSize;
    // Mirror applyAppearance's code line-height coupling so a larger draft size
    // doesn't clip while the user is still typing it.
    style.lineHeight = Math.round(fontSize * 1.5);
  }
  // High-churn draft values bypass the Unistyles CSS registry (docs/unistyles.md).
  return inlineUnistylesStyle(style);
}

interface KeyedToken {
  key: string;
  style: string | null;
  text: string;
}

interface KeyedLine {
  key: string;
  lineNumber: number;
  isChanged: boolean;
  tokens: KeyedToken[] | null;
  fallbackText: string;
}

// Tokenize the whole column once, then precompute stable keys and the plain-text
// fallback per line. Keys are computed here (not at the JSX map index) so the
// renderer reads `.key` rather than the array index.
function buildKeyedLines(lineTexts: string[], side: "before" | "after"): KeyedLine[] {
  const tokenLines = tokenizeToLines(lineTexts.join("\n"), PREVIEW_EXTENSION);
  return lineTexts.map((lineText, index) => {
    const raw = tokenLines?.[index] ?? null;
    const tokens =
      raw && raw.length > 0
        ? raw.map((token, tokenIndex) => ({
            key: `${side}-${index}-${tokenIndex}`,
            style: token.style,
            text: token.text,
          }))
        : null;
    return {
      key: `${side}-${index}`,
      lineNumber: index + 1,
      isChanged: CHANGED_LINE_INDICES.has(index),
      tokens,
      fallbackText: lineText.length > 0 ? lineText : ZERO_WIDTH,
    };
  });
}

interface PreviewColumnProps {
  lineTexts: string[];
  side: "before" | "after";
  codeOverride: TextStyle;
}

function PreviewColumn({ lineTexts, side, codeOverride }: PreviewColumnProps) {
  const lines = useMemo(() => buildKeyedLines(lineTexts, side), [lineTexts, side]);
  const changedRowStyle = useMemo(
    () => [styles.lineRow, side === "before" ? styles.removedLine : styles.addedLine],
    [side],
  );
  const gutterStyle = useMemo(() => [styles.gutterText, codeOverride], [codeOverride]);
  const codeStyle = useMemo(() => [styles.codeLine, codeOverride], [codeOverride]);

  return (
    <View style={styles.column}>
      {lines.map((line) => (
        <View key={line.key} style={line.isChanged ? changedRowStyle : styles.lineRow}>
          <Text style={gutterStyle}>{String(line.lineNumber)}</Text>
          <Text style={codeStyle}>
            {line.tokens
              ? line.tokens.map((token) => (
                  <Text
                    key={token.key}
                    style={token.style ? syntaxTokenStyleFor(token.style) : undefined}
                  >
                    {token.text}
                  </Text>
                ))
              : line.fallbackText}
          </Text>
        </View>
      ))}
    </View>
  );
}

// Self-contained live preview: a side-by-side diff of a fixed TypeScript snippet
// in the code (mono) font with the selected syntax colors. All themed styling
// flows through StyleSheet.create((theme) => …) so it repaints when
// UnistylesRuntime.updateTheme commits a setting; the optional `overrides` layer
// inline styles for live-while-typing feedback on the code font.
export function AppearancePreview({ overrides }: AppearancePreviewProps) {
  const isCompact = useIsCompactFormFactor();
  const codeOverride = useMemo(() => buildCodeOverride(overrides), [overrides]);

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Live preview of the syntax theme and code font"
      style={styles.card}
    >
      <View style={isCompact ? styles.bodyStacked : styles.bodySplit}>
        <PreviewColumn lineTexts={PREVIEW_BEFORE} side="before" codeOverride={codeOverride} />
        <PreviewColumn lineTexts={PREVIEW_AFTER} side="after" codeOverride={codeOverride} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  bodySplit: {
    flexDirection: "row",
  },
  bodyStacked: {
    flexDirection: "column",
  },
  column: {
    flex: 1,
    paddingVertical: theme.spacing[2],
  },
  lineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  gutterText: {
    width: theme.spacing[8],
    paddingRight: theme.spacing[2],
    textAlign: "right",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    color: theme.colors.foregroundMuted,
    userSelect: "none",
    flexShrink: 0,
  },
  codeLine: {
    flex: 1,
    paddingRight: theme.spacing[3],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    color: theme.colors.foreground,
    ...(isWeb ? { whiteSpace: "pre", overflowWrap: "normal" } : null),
  },
  removedLine: {
    backgroundColor: REMOVED_TINT,
  },
  addedLine: {
    backgroundColor: ADDED_TINT,
  },
}));
