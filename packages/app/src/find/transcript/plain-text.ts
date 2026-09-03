import type MarkdownIt from "markdown-it";
import { getMarkdownFenceLanguage } from "@/components/markdown/fence/language";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

type MarkdownToken = ReturnType<MarkdownIt["parse"]>[number];

/**
 * The same parser the assistant message renders with. Anything else — a different
 * `linkify` setting, `typographer` on — moves characters around and the projection
 * stops agreeing with the DOM about where a match starts.
 */
const parser = createAssistantMarkdownParser();

/**
 * Blocks are rendered into separate containers and searched as separate DOM roots,
 * so a DOM match can never cross this separator. A newline cannot be typed into the
 * find input either, which keeps the projection's match count equal to the DOM's.
 */
const BLOCK_SEPARATOR = "\n";

/**
 * The text an assistant message actually paints, projected from its markdown.
 *
 * Find counts matches here rather than in the DOM because most of a long transcript
 * is virtualized away. The projection therefore has to reproduce what
 * react-native-markdown-display puts on screen for `components/message.tsx`'s rules:
 * text, inline code and fence bodies, with nothing invented between them. Link URLs,
 * emphasis markers, heading hashes, table pipes, list markers (marked
 * `data-paseo-markdown-ignore`) and image alts are not painted, so they are not here.
 *
 * The message is split into blocks first because that is how it is rendered — one
 * markdown-it pass per block, not one for the whole message.
 */
export function assistantPlainText(markdown: string): string {
  return splitMarkdownBlocks(markdown).map(blockPlainText).join(BLOCK_SEPARATOR);
}

function blockPlainText(block: string): string {
  let text = "";
  for (const token of parser.parse(block, {})) {
    text += blockTokenText(token);
  }
  return text;
}

function blockTokenText(token: MarkdownToken): string {
  switch (token.type) {
    case "inline":
      return (token.children ?? []).map(inlineTokenText).join("");
    case "fence":
      // A mermaid fence paints its source or its diagram depending on a sandboxed
      // iframe, the source policy, a render error and a "View source" toggle, so no
      // static projection can be right. It contributes nothing here, and the source
      // container carries `data-paseo-find-ignore` so the DOM walk agrees
      // (find/dom/markers.ts).
      return getMarkdownFenceLanguage(token.info) === "mermaid"
        ? ""
        : stripTerminalFenceNewline(token.content);
    case "code_block":
      return stripTerminalFenceNewline(token.content);
    default:
      // Block open/close tokens carry no content of their own, and the renderer puts
      // no text between the containers they produce.
      return "";
  }
}

function inlineTokenText(token: MarkdownToken): string {
  switch (token.type) {
    case "text":
    case "code_inline":
      return token.content;
    case "softbreak":
    case "hardbreak":
      return "\n";
    default:
      return "";
  }
}

/** Mirrors HighlightedCodeBlock, which drops the newline every fence body ends with. */
function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}
