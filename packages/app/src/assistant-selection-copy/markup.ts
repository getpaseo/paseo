export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-paseo-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-paseo-markdown-ignore";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-paseo-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-paseo-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-paseo-markdown-language";

export const markdownCopyDataSet = {
  blockquote: { paseoMarkdownTag: "blockquote" },
  br: { paseoMarkdownTag: "br" },
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
  unwrap: { paseoMarkdownUnwrap: "true" },
} as const;

export type MarkdownCopyInlineTag = "br" | "code" | "em" | "s" | "strong";

export function markdownCopyOrderedListDataSet(start: unknown) {
  return {
    ...markdownCopyDataSet.ol,
    paseoMarkdownListStart: String(start ?? 1),
  } as const;
}

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { paseoMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}
