export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-paseo-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-paseo-markdown-ignore";

export const markdownCopyDataSet = {
  blockquote: { paseoMarkdownTag: "blockquote" },
  code: { paseoMarkdownTag: "code" },
  h1: { paseoMarkdownTag: "h1" },
  h2: { paseoMarkdownTag: "h2" },
  h3: { paseoMarkdownTag: "h3" },
  h4: { paseoMarkdownTag: "h4" },
  h5: { paseoMarkdownTag: "h5" },
  h6: { paseoMarkdownTag: "h6" },
  hr: { paseoMarkdownTag: "hr" },
  ignore: { paseoMarkdownIgnore: "true" },
  li: { paseoMarkdownTag: "li" },
  ol: { paseoMarkdownTag: "ol" },
  p: { paseoMarkdownTag: "p" },
  pre: { paseoMarkdownTag: "pre" },
  s: { paseoMarkdownTag: "s" },
  strong: { paseoMarkdownTag: "strong" },
  em: { paseoMarkdownTag: "em" },
  table: { paseoMarkdownTag: "table" },
  tbody: { paseoMarkdownTag: "tbody" },
  td: { paseoMarkdownTag: "td" },
  th: { paseoMarkdownTag: "th" },
  thead: { paseoMarkdownTag: "thead" },
  tr: { paseoMarkdownTag: "tr" },
  ul: { paseoMarkdownTag: "ul" },
} as const;

export type MarkdownCopyInlineTag = "code" | "em" | "s" | "strong";
