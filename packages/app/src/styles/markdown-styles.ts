import type { Theme } from "./theme";
import { isWeb } from "@/constants/platform";

const webSelectableTextStyle = isWeb ? { userSelect: "text" as const } : {};

/**
 * Creates comprehensive markdown styles for react-native-markdown-display.
 *
 * Usage:
 *   const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
 *   <Markdown style={markdownStyles}>{content}</Markdown>
 */
export function createMarkdownStyles(theme: Theme) {
  return {
    // =========================================================================
    // BASE STYLES
    // =========================================================================

    body: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      // Prose line-height scales with the UI ramp (≈22 at base 16), NOT the
      // code-size-coupled lineHeight.diff token used by code/diff surfaces.
      lineHeight: Math.round(theme.fontSize.base * 1.4),
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    text: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
      ...(isWeb ? { wordBreak: "break-word" as const } : {}),
    },

    paragraph: {
      marginTop: 0,
      marginBottom: theme.spacing[2],
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    heading1: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize["2xl"],
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: 30,
    },

    heading2: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.xl,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: 26,
    },

    heading3: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.lg,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: 24,
    },

    heading4: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: 24,
    },

    heading5: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      marginTop: theme.spacing[2],
      marginBottom: theme.spacing[1],
      lineHeight: 22,
    },

    heading6: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foregroundMuted,
      marginTop: theme.spacing[2],
      marginBottom: theme.spacing[1],
      lineHeight: 20,
      letterSpacing: 0,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      ...webSelectableTextStyle,
      fontWeight: theme.fontWeight.medium,
    },

    em: {
      ...webSelectableTextStyle,
      fontStyle: "italic" as const,
    },

    s: {
      ...webSelectableTextStyle,
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
      ...(isWeb ? { wordBreak: "break-word" as const } : {}),
    },

    blocklink: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
      ...(isWeb ? { wordBreak: "break-word" as const } : {}),
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.md,
      borderWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      lineHeight: Math.round(theme.fontSize.code * 1.45),
    },

    // Explicitly override react-native-markdown-display defaults (#f5f5f5 /
    // #CCCCCC) so dark themes never leak a light code surface.
    code_block: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing[3],
      color: theme.colors.foreground,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: theme.spacing[2],
    },

    fence: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing[3],
      color: theme.colors.foreground,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: theme.spacing[2],
    },

    pre: {
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // TABLES
    // =========================================================================

    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      marginVertical: theme.spacing[2],
    },

    thead: {
      backgroundColor: theme.colors.surface2,
    },

    tbody: {},

    th: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      textAlign: "left" as const,
    },

    tr: {
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
      flexDirection: "row" as const,
    },

    td: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      flex: 1,
    },

    // =========================================================================
    // LISTS
    // =========================================================================

    bullet_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    list_item: {
      marginBottom: theme.spacing[1],
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      flexShrink: 1,
    },

    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    bullet_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      lineHeight: 22,
    },

    ordered_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.normal,
      lineHeight: 22,
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      backgroundColor: "transparent",
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.borderAccent,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
      marginVertical: theme.spacing[3],
    },

    // =========================================================================
    // HORIZONTAL RULE
    // =========================================================================

    hr: {
      backgroundColor: theme.colors.border,
      height: 1,
      marginVertical: theme.spacing[6],
    },

    // =========================================================================
    // IMAGES
    // =========================================================================

    image: {
      borderRadius: theme.borderRadius.md,
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // BREAKS
    // =========================================================================

    hardbreak: {
      height: theme.spacing[2],
    },

    softbreak: {},
  };
}

/**
 * Thinking / reasoning prose: same size and line-height as assistant replies,
 * muted color, and no trailing paragraph gap (the stream owns separation from
 * the next reply line — stacking paragraph margin + stream gap looked like a
 * blank line).
 */
export function createThinkingMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);
  const proseLineHeight = Math.round(theme.fontSize.base * 1.4);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.base,
      lineHeight: proseLineHeight,
    },

    text: {
      ...baseStyles.text,
      color: theme.colors.foregroundMuted,
    },

    paragraph: {
      ...baseStyles.paragraph,
      // Keep a tight step between thinking paragraphs; zero trailing gap so the
      // following stream item (assistant line / speak) sits on the same rhythm.
      marginBottom: theme.spacing[1],
    },
  };
}

/**
 * Creates a smaller variant of markdown styles for compact UI elements
 * like thought bubbles, tooltips, or side panels.
 */
export function createCompactMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      fontSize: theme.fontSize.sm,
      lineHeight: 20,
    },

    heading1: {
      ...baseStyles.heading1,
      fontSize: theme.fontSize.xl,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: 26,
    },

    heading2: {
      ...baseStyles.heading2,
      fontSize: theme.fontSize.lg,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: 24,
    },

    heading3: {
      ...baseStyles.heading3,
      fontSize: theme.fontSize.base,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: 22,
    },

    paragraph: {
      ...baseStyles.paragraph,
      marginBottom: theme.spacing[2],
    },

    code_inline: {
      ...baseStyles.code_inline,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },
  };
}
