/** Presentation contract for author-controlled registry content, independent of the UI runtime. */
export const pluginOverviewPolicy = {
  rawHtml: false,
  elements: [
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "del",
    "pre",
    "code",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  link: { rel: "noopener noreferrer nofollow", target: "_blank" },
} as const;

/** Validate decoded Markdown destinations; never resolve against the reader's page or repository. */
export function pluginOverviewUrl(value: string | undefined): string | undefined {
  // URL parsers discard controls and normalize backslashes; reject those ambiguous spellings.
  // eslint-disable-next-line no-control-regex
  if (!value || !/^https:\/\/[^/?#]/i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
