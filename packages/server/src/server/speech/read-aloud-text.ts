/**
 * Turn an agent's message into something worth hearing.
 *
 * Agent output is raw screen text: it carries markdown syntax, and agent
 * messages carry Paseo's own wrapper tags (`<spoken-input>`, `<instruction>`).
 * Synthesized verbatim those become spoken noise — "spoken input, are you
 * working" — so they are stripped before they reach the TTS provider.
 *
 * Deliberately conservative: this removes markup, it does not reflow or
 * summarize. Anything it cannot confidently classify as syntax is spoken.
 */

/** `<tag>`, `</tag>`, `<tag attr="x" />` — not bare `<` in `a < b`. */
const HTML_LIKE_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/** Fenced code blocks: the fence markers and language tag, not the code. */
const CODE_FENCE = /^```.*$/gm;

/** Inline code, bold, italic, and strikethrough markers around their content. */
const INLINE_MARKERS = /[`*_~]/g;

/** Leading `#`, `>`, `-`, `*`, `+` and list numbering at the start of a line. */
const LINE_LEAD_MARKERS = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm;

/** `[label](https://…)` — the label is speakable, the URL is not. */
const MARKDOWN_LINK = /\[([^\]]*)\]\((?:[^)]*)\)/g;

/** Anything with a letter or a digit has something to pronounce. */
const HAS_SPEAKABLE_CONTENT = /[\p{L}\p{N}]/u;

export function sanitizeTextForReadAloud(text: string): string {
  return text
    .replace(CODE_FENCE, " ")
    .replace(HTML_LIKE_TAG, " ")
    .replace(MARKDOWN_LINK, "$1")
    .replace(LINE_LEAD_MARKERS, "")
    .replace(INLINE_MARKERS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a fragment is worth sending to the provider. Punctuation-only
 * fragments synthesize to empty audio, which the client cannot decode.
 */
export function hasSpeakableContent(text: string): boolean {
  return HAS_SPEAKABLE_CONTENT.test(text);
}
