import type { MarkdownDisplayPart, MarkdownInlineImagePart } from "./html-ish";

export type MarkdownPartGroup =
  | { kind: "part"; part: MarkdownDisplayPart }
  | { kind: "imageText"; images: MarkdownInlineImagePart[]; lead: string; rest: string };

/**
 * Pairs a run of inline images that flow with text (small status images at the
 * start of a line, GitHub-style) with the lead paragraph of the following
 * markdown part, so the renderer can lay them out side by side instead of
 * stacking the images as their own blocks.
 *
 * Between consecutive flowing images the parser may emit whitespace-only
 * markdown parts — these are consumed and discarded when building the group.
 */
export function groupMarkdownParts(parts: readonly MarkdownDisplayPart[]): MarkdownPartGroup[] {
  const groups: MarkdownPartGroup[] = [];
  let index = 0;

  while (index < parts.length) {
    const part = parts[index];

    if (part.kind === "inlineImage" && part.flowsWithText) {
      // Collect the maximal run of flowing images, skipping whitespace-only markdown between them.
      const images: MarkdownInlineImagePart[] = [part];
      let lookahead = index + 1;

      while (lookahead < parts.length) {
        const candidate = parts[lookahead];
        if (candidate === undefined) {
          break;
        }
        if (isWhitespaceOnlyMarkdown(candidate)) {
          lookahead += 1;
          continue;
        }
        if (candidate.kind === "inlineImage" && candidate.flowsWithText) {
          images.push(candidate);
          lookahead += 1;
          continue;
        }
        break;
      }

      const trailing = parts[lookahead];
      if (trailing?.kind === "markdown") {
        const { lead, rest } = splitLeadParagraph(trailing.text);
        if (lead) {
          groups.push({ kind: "imageText", images, lead, rest });
          index = lookahead + 1;
          continue;
        }
      }

      // No usable lead — emit the images (and any whitespace parts) as plain parts.
      for (let i = index; i < lookahead; i += 1) {
        const p = parts[i];
        if (p !== undefined) {
          groups.push({ kind: "part", part: p });
        }
      }
      index = lookahead;
      continue;
    }

    groups.push({ kind: "part", part });
    index += 1;
  }

  return groups;
}

function isWhitespaceOnlyMarkdown(part: MarkdownDisplayPart): boolean {
  return part.kind === "markdown" && part.text.trim() === "";
}

function splitLeadParagraph(text: string): { lead: string; rest: string } {
  if (/^[ \t]*\r?\n/.test(text)) {
    return { lead: "", rest: text };
  }
  const boundary = /\r?\n[ \t]*\r?\n/.exec(text);
  if (!boundary) {
    return { lead: text.trim(), rest: "" };
  }
  return {
    lead: text.slice(0, boundary.index).trim(),
    rest: text.slice(boundary.index + boundary[0].length),
  };
}
