import type MarkdownIt from "markdown-it";
import { createMarkdownParser } from "@/utils/markdown-parser";
import { enableStreamingMarkdown } from "@/utils/streaming-markdown";

export function createAssistantMarkdownParser({ streaming = false } = {}): MarkdownIt {
  const parser = createMarkdownParser({ linkify: true });
  const defaultValidateLink = parser.validateLink.bind(parser);

  // Assistant messages are the only surface allowed to link into the
  // filesystem. Every other parser keeps markdown-it's stricter default.
  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  if (streaming) {
    enableStreamingMarkdown(parser);
  }

  // Tokens carry their local fence ordinal into the AST; React keys are regenerated per parse.
  parser.core.ruler.push("fence_identity", (state) => {
    let index = 0;
    for (const token of state.tokens) {
      if (token.type === "fence") token.attrSet("data-fence-index", String(index++));
    }
  });
  return parser;
}
