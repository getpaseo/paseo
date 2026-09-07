import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { getVideoMimeTypeFromPath } from "@/attachments/file-types";

export function assistantVideoMarkdown(parser: MarkdownIt): void {
  parser.core.ruler.after("linkify", "assistant_video", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      block.children = appendVideoBlocks(block.children, state.Token);
    }
  });
}

function appendVideoBlocks(tokens: Token[], TokenClass: typeof Token): Token[] {
  const result: Token[] = [];
  const videos = new Map<string, Token>();
  let insideLink = false;
  for (const token of tokens) {
    if (token.type === "link_open") insideLink = true;
    if (token.type === "link_close") insideLink = false;
    const source = videoSource(token);
    if (!source) {
      result.push(token);
      continue;
    }

    if (token.type === "image") {
      const label = new TokenClass("text", "", 0);
      label.content = token.content || source;
      if (insideLink) {
        result.push(label);
      } else {
        const open = new TokenClass("link_open", "a", 1);
        open.attrSet("href", source);
        result.push(open, label, new TokenClass("link_close", "a", -1));
      }
    } else {
      result.push(token);
    }
    const video = new TokenClass("video", "video", 0);
    video.block = true;
    video.attrSet("src", source);
    videos.set(source, video);
  }
  // Append outside links/emphasis and native text groups so controls stay interactive.
  return [...result, ...videos.values()];
}

function videoSource(token: Token): string | null {
  let source: string | null = null;
  if (token.type === "link_open") source = token.attrGet("href");
  if (token.type === "image") source = token.attrGet("src");
  return source && getVideoMimeTypeFromPath(source) ? source : null;
}
