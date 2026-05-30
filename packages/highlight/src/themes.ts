import { darkHighlightColors, lightHighlightColors } from "./colors.js";
import type { HighlightStyle } from "./types.js";

export type SyntaxThemeId = "auto" | "github-light" | "github-dark" | "dracula" | "one-dark";

export const SYNTAX_THEME_IDS: readonly SyntaxThemeId[] = [
  "auto",
  "github-light",
  "github-dark",
  "dracula",
  "one-dark",
];

export interface SyntaxThemeOption {
  id: SyntaxThemeId;
  label: string;
}

export const SYNTAX_THEME_OPTIONS: readonly SyntaxThemeOption[] = [
  { id: "auto", label: "Auto" },
  { id: "github-light", label: "GitHub Light" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "one-dark", label: "One Dark" },
];

export type SyntaxColors = Record<HighlightStyle, string>;

// Canonical Dracula palette: purple #bd93f9, pink #ff79c6, green #50fa7b,
// yellow #f1fa8c, cyan #8be9fd, orange #ffb86c, comment #6272a4, fg #f8f8f2.
const draculaColors: SyntaxColors = {
  keyword: "#ff79c6",
  comment: "#6272a4",
  string: "#f1fa8c",
  number: "#bd93f9",
  literal: "#bd93f9",
  function: "#50fa7b",
  definition: "#50fa7b",
  class: "#8be9fd",
  type: "#8be9fd",
  tag: "#ff79c6",
  attribute: "#50fa7b",
  property: "#f8f8f2",
  variable: "#f8f8f2",
  operator: "#ff79c6",
  punctuation: "#f8f8f2",
  regexp: "#ffb86c",
  escape: "#ffb86c",
  meta: "#6272a4",
  heading: "#bd93f9",
  link: "#8be9fd",
};

// Canonical One Dark palette: purple #c678dd, red #e06c75, green #98c379,
// yellow #e5c07b, blue #61afef, cyan #56b6c2, orange #d19a66, comment #5c6370, fg #abb2bf.
const oneDarkColors: SyntaxColors = {
  keyword: "#c678dd",
  comment: "#5c6370",
  string: "#98c379",
  number: "#d19a66",
  literal: "#d19a66",
  function: "#61afef",
  definition: "#61afef",
  class: "#e5c07b",
  type: "#e5c07b",
  tag: "#e06c75",
  attribute: "#d19a66",
  property: "#e06c75",
  variable: "#abb2bf",
  operator: "#56b6c2",
  punctuation: "#abb2bf",
  regexp: "#98c379",
  escape: "#56b6c2",
  meta: "#5c6370",
  heading: "#e06c75",
  link: "#61afef",
};

export function isSyntaxThemeId(value: string): value is SyntaxThemeId {
  return (SYNTAX_THEME_IDS as readonly string[]).includes(value);
}

export function resolveSyntaxColors(
  id: SyntaxThemeId,
  colorScheme: "light" | "dark",
): SyntaxColors {
  switch (id) {
    case "auto":
      return colorScheme === "dark" ? darkHighlightColors : lightHighlightColors;
    case "github-light":
      return lightHighlightColors;
    case "github-dark":
      return darkHighlightColors;
    case "dracula":
      return draculaColors;
    case "one-dark":
      return oneDarkColors;
  }
}
