/**
 * Marks the element that holds one rendered Markdown document. A `#heading` link
 * looks for its target inside this boundary only, so it cannot scroll into a
 * neighbouring message or a shared list container.
 */
export const MARKDOWN_DOCUMENT_ATTRIBUTE = "data-paseo-markdown-document";

// Stable reference: react-native-web turns the key into the attribute above, and
// a fresh object every render would trip the react-perf rule. Renders nothing on
// native.
export const MARKDOWN_DOCUMENT_DATASET = { paseoMarkdownDocument: "" } as const;
