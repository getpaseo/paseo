export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-paseo-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-paseo-markdown-ignore";
export const MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE = "data-paseo-markdown-list-marker";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-paseo-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-paseo-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-paseo-markdown-language";
export const MARKDOWN_COPY_ALIGN_ATTRIBUTE = "data-paseo-markdown-align";
export const MARKDOWN_COPY_SRC_ATTRIBUTE = "data-paseo-markdown-src";
export const MARKDOWN_COPY_ALT_ATTRIBUTE = "data-paseo-markdown-alt";

/**
 * Trailing line breaks, with any indentation that followed the last one.
 *
 * Both ways of copying code strip these, for the same reason: pasting a trailing
 * newline into a terminal runs the last line. A fence body always ends in one, and
 * ends in several when the author left blank lines before the closing fence; a
 * selection picks one up whenever it overshoots the end of a rendered line.
 */
export const TRAILING_CODE_LINE_BREAKS = /(\r?\n[ \t]*)+$/;

export const markdownCopyDataSet = {
  code: { paseoMarkdownTag: "code" },
  pre: { paseoMarkdownTag: "pre" },
  ignore: { paseoMarkdownIgnore: "true" },
} as const;

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { paseoMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

export const MARKDOWN_COPY_IMAGE_SOURCES_ATTRIBUTE = "data-paseo-markdown-image-sources";
export function markdownCopyImageSourcesDataSet(sources: Record<string, string>) {
  return { paseoMarkdownImageSources: JSON.stringify(sources) };
}
