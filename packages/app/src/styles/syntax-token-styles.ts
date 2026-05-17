import { StyleSheet } from "react-native-unistyles";

// Per-token color styles for syntax-highlighted code. Each value reads a
// theme path so the Unistyles Babel plugin tracks the dependency and updates
// native style values on theme changes — no React re-render of consumers.
// Used by message code blocks (hot path), file preview, and the diff viewer.
export const syntaxTokenStyles = StyleSheet.create((theme) => ({
  base: { color: theme.colors.foreground },
  keyword: { color: theme.colors.syntax.keyword },
  comment: { color: theme.colors.syntax.comment },
  string: { color: theme.colors.syntax.string },
  number: { color: theme.colors.syntax.number },
  literal: { color: theme.colors.syntax.literal },
  function: { color: theme.colors.syntax.function },
  definition: { color: theme.colors.syntax.definition },
  class: { color: theme.colors.syntax.class },
  type: { color: theme.colors.syntax.type },
  tag: { color: theme.colors.syntax.tag },
  attribute: { color: theme.colors.syntax.attribute },
  property: { color: theme.colors.syntax.property },
  variable: { color: theme.colors.syntax.variable },
  operator: { color: theme.colors.syntax.operator },
  punctuation: { color: theme.colors.syntax.punctuation },
  regexp: { color: theme.colors.syntax.regexp },
  escape: { color: theme.colors.syntax.escape },
  meta: { color: theme.colors.syntax.meta },
  heading: { color: theme.colors.syntax.heading },
  link: { color: theme.colors.syntax.link },
}));

type SyntaxTokenStyleValue = (typeof syntaxTokenStyles)["base"];

// Accepts a plain string so diff tokens (server-typed `string | null`) and
// @getpaseo/highlight tokens (typed `HighlightStyle | null`) share one path.
// Unknown styles fall back to the base color.
export function syntaxTokenStyleFor(style: string | null | undefined): SyntaxTokenStyleValue {
  if (!style) return syntaxTokenStyles.base;
  const indexed = syntaxTokenStyles as unknown as Record<string, SyntaxTokenStyleValue>;
  return indexed[style] ?? syntaxTokenStyles.base;
}
