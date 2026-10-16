import type { MarkdownStyle } from "react-native-enriched-markdown";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";

export function createMarkdownStyles(
  theme: Theme,
  compact = false,
): { markdownStyle: MarkdownStyle; selectionColor: string } {
  const fontSize = compact ? theme.fontSize.base : theme.fontSize.content;
  const paragraph = {
    fontSize,
    fontFamily: theme.fontFamily.ui,
    lineHeight: Math.round(fontSize * 1.4),
    color: theme.colors.foreground,
    marginTop: 0,
    marginBottom: theme.spacing[3],
  };
  const heading = (scale: number) => ({
    ...paragraph,
    fontSize: Math.round(fontSize * scale),
    lineHeight: Math.round(fontSize * scale * 1.3),
    fontWeight: "bold",
    marginTop: theme.spacing[3],
  });
  return {
    selectionColor: theme.colors.terminal.selectionBackground,
    markdownStyle: {
      paragraph,
      h1: heading(1.6),
      h2: heading(1.4),
      h3: heading(1.2),
      h4: heading(1.1),
      h5: heading(1),
      h6: { ...heading(1), color: theme.colors.foregroundMuted },
      list: {
        ...paragraph,
        bulletColor: theme.colors.foregroundMuted,
        markerColor: theme.colors.foregroundMuted,
        gapWidth: 7,
        itemSpacing: 4,
        marginLeft: 20,
      },
      blockquote: {
        ...paragraph,
        color: `${theme.colors.foreground}cc`,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.surface2,
        borderWidth: 3,
        padding: 12,
        gapWidth: 8,
        admonitions: {
          note: { color: theme.colors.accentBright, backgroundColor: theme.colors.surface2 },
          tip: { color: theme.colors.statusSuccess, backgroundColor: theme.colors.surface2 },
          important: { color: theme.colors.statusMerged, backgroundColor: theme.colors.surface2 },
          warning: { color: theme.colors.statusWarning, backgroundColor: theme.colors.surface2 },
          caution: { color: theme.colors.statusDanger, backgroundColor: theme.colors.surface2 },
        },
      },
      link: { color: theme.colors.accentBright, underline: false },
      linkVariants: {
        "^(?!https?://).+": {
          color: theme.colors.accentBright,
        },
      },
      code: {
        fontFamily: theme.fontFamily.mono === "ui-monospace" && !isWeb ? "" : theme.fontFamily.mono,
        fontSize: theme.fontSize.code,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderColor: "transparent",
      },
      codeBlock: {
        ...paragraph,
        fontFamily: theme.fontFamily.mono === "ui-monospace" && !isWeb ? "" : theme.fontFamily.mono,
        fontSize: theme.fontSize.code,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 12,
      },
      table: {
        ...paragraph,
        borderColor: theme.colors.border,
        headerBackgroundColor: theme.colors.surface2,
        headerTextColor: theme.colors.foreground,
        rowEvenBackgroundColor: theme.colors.surface0,
        rowOddBackgroundColor: theme.colors.surface1,
      },
      taskList: {
        checkedTextColor: theme.colors.foregroundMuted,
        checkedColor: theme.colors.accent,
        checkmarkColor: theme.colors.accentForeground,
        borderColor: theme.colors.foregroundMuted,
      },
      inlineImage: { size: paragraph.lineHeight },
      image: { height: 320, resizeMode: "contain", borderRadius: 8 },
      thematicBreak: { color: theme.colors.border, height: 1, marginTop: 12, marginBottom: 12 },
    },
  };
}
