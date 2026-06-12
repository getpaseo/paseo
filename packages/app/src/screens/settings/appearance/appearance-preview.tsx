import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HighlightToken } from "@getpaseo/highlight";
import { isWeb } from "@/constants/platform";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
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

// Zero-width space keeps blank lines at full line height.
const ZERO_WIDTH = "​";

type RowType = "context" | "add" | "remove";

interface PreviewOverrides {
  monoFontFamily?: string;
  codeFontSize?: number;
}

interface AppearancePreviewProps {
  // Live draft values for the code font applied as inline overrides on top of the
  // themed styles (the while-typing path). Absent/empty fields fall back to the
  // theme value; an explicitly-empty family resolves to the default stack.
  overrides?: PreviewOverrides;
}

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

interface UnifiedRow {
  key: string;
  type: RowType;
  marker: string;
  tokens: KeyedToken[] | null;
  fallbackText: string;
}

function makeRow(
  key: string,
  type: RowType,
  marker: string,
  text: string,
  raw: HighlightToken[] | null,
): UnifiedRow {
  const tokens =
    raw && raw.length > 0
      ? raw.map((token, index) => ({
          key: `${key}-${index}`,
          style: token.style,
          text: token.text,
        }))
      : null;
  return { key, type, marker, tokens, fallbackText: text.length > 0 ? text : ZERO_WIDTH };
}

// Interleave the before/after snippet into a single unified diff: unchanged lines
// appear once as context; a changed line emits a "-" removed row (from BEFORE)
// followed by a "+" added row (from AFTER). Tokens are precomputed with stable
// keys so the renderer never keys off an array index.
function buildUnifiedRows(): UnifiedRow[] {
  const beforeLines = tokenizeToLines(PREVIEW_BEFORE.join("\n"), PREVIEW_EXTENSION);
  const afterLines = tokenizeToLines(PREVIEW_AFTER.join("\n"), PREVIEW_EXTENSION);
  const rows: UnifiedRow[] = [];
  for (let index = 0; index < PREVIEW_BEFORE.length; index += 1) {
    if (CHANGED_LINE_INDICES.has(index)) {
      rows.push(
        makeRow(`r-${index}`, "remove", "- ", PREVIEW_BEFORE[index], beforeLines?.[index] ?? null),
      );
      rows.push(
        makeRow(`a-${index}`, "add", "+ ", PREVIEW_AFTER[index], afterLines?.[index] ?? null),
      );
    } else {
      rows.push(
        makeRow(`c-${index}`, "context", "  ", PREVIEW_BEFORE[index], beforeLines?.[index] ?? null),
      );
    }
  }
  return rows;
}

// Marker color follows the diff stat tokens; a single style ref per type keeps it
// off the new-array-as-prop path. The marker is a child of the code <Text>, so it
// inherits the mono font + (draft) size and only overrides its color.
function markerStyle(type: RowType) {
  if (type === "add") return styles.markerAdd;
  if (type === "remove") return styles.markerRemove;
  return styles.markerContext;
}

// Self-contained live preview: a unified diff of a fixed TypeScript snippet in the
// code (mono) font with the selected syntax colors. All themed styling flows
// through StyleSheet.create((theme) => …) so it repaints when
// UnistylesRuntime.updateTheme commits a setting; the optional `overrides` layer
// inline styles for live-while-typing feedback on the code font.
export function AppearancePreview({ overrides }: AppearancePreviewProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => buildUnifiedRows(), []);
  const codeOverride = useMemo(() => buildCodeOverride(overrides), [overrides]);
  const codeStyle = useMemo(() => [styles.codeLine, codeOverride], [codeOverride]);
  const addRowStyle = useMemo(() => [styles.row, styles.addRow], []);
  const removeRowStyle = useMemo(() => [styles.row, styles.removeRow], []);

  function rowStyle(type: RowType) {
    if (type === "add") return addRowStyle;
    if (type === "remove") return removeRowStyle;
    return styles.row;
  }

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={t("settings.appearance.syntax.previewAccessibility")}
      dataSet={CODE_SURFACE_DATASET}
      style={styles.card}
    >
      {rows.map((row) => (
        <View key={row.key} style={rowStyle(row.type)}>
          <Text style={codeStyle}>
            <Text style={markerStyle(row.type)}>{row.marker}</Text>
            {row.tokens
              ? row.tokens.map((token) => (
                  <Text
                    key={token.key}
                    style={token.style ? syntaxTokenStyleFor(token.style) : undefined}
                  >
                    {token.text}
                  </Text>
                ))
              : row.fallbackText}
          </Text>
        </View>
      ))}
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
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[3],
  },
  addRow: {
    backgroundColor: ADDED_TINT,
  },
  removeRow: {
    backgroundColor: REMOVED_TINT,
  },
  codeLine: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    color: theme.colors.foreground,
    ...(isWeb ? { whiteSpace: "pre", overflowWrap: "normal" } : null),
  },
  markerContext: {
    color: theme.colors.foregroundMuted,
  },
  markerAdd: {
    color: theme.colors.diffAddition,
  },
  markerRemove: {
    color: theme.colors.diffDeletion,
  },
}));
