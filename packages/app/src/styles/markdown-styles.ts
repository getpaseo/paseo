import type { Theme } from "./theme";
import { Fonts } from "@/constants/theme";

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
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      lineHeight: 22,
    },

    text: {
      color: theme.colors.foreground,
    },

    paragraph: {
      marginTop: 0,
      marginBottom: theme.spacing[3],
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    heading1: {
      fontSize: theme.fontSize["3xl"],
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: 32,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading2: {
      fontSize: theme.fontSize["2xl"],
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: 28,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading3: {
      fontSize: theme.fontSize.xl,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: 26,
    },

    heading4: {
      fontSize: theme.fontSize.lg,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: 24,
    },

    heading5: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: 22,
    },

    heading6: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foregroundMuted,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: 20,
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      fontWeight: theme.fontWeight.medium,
    },

    em: {
      fontStyle: "italic" as const,
    },

    s: {
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      color: theme.colors.primary,
      textDecorationLine: "underline" as const,
    },

    blocklink: {
      color: theme.colors.primary,
      textDecorationLine: "underline" as const,
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.sm,
    },

    code_block: {
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.sm,
      marginVertical: theme.spacing[2],
    },

    fence: {
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.sm,
      marginVertical: theme.spacing[3],
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
      marginVertical: theme.spacing[3],
    },

    thead: {
      backgroundColor: theme.colors.surface2,
    },

    tbody: {},

    th: {
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
      marginVertical: theme.spacing[2],
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      marginVertical: theme.spacing[2],
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
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      lineHeight: 22,
    },

    ordered_list_icon: {
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.semibold,
      lineHeight: 22,
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.primary,
      paddingHorizontal: theme.spacing[4],
      paddingVertical: theme.spacing[3],
      marginVertical: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
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
      fontSize: theme.fontSize.xs,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.xs,
      padding: theme.spacing[2],
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.xs,
      padding: theme.spacing[2],
    },
  };
}
