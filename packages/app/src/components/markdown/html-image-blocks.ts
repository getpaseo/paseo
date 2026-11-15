import { Parser } from "htmlparser2";
import { fromMarkdown } from "mdast-util-from-markdown";
import { referenceDefinitionSource } from "./definitions";

export interface HtmlImage {
  /** Position in its row; images keep their source order. */
  id: string;
  src: string;
  alt: string;
  href?: string;
  width?: number;
  height?: number;
}

export interface HtmlImageRow {
  id: string;
  align: "left" | "center" | "right";
  images: HtmlImage[];
}

export type MarkdownBlock =
  | { kind: "markdown"; id: string; source: string }
  | { kind: "images"; id: string; rows: HtmlImageRow[] };

// An HTML block that holds nothing but images, like a README screenshot table or a
// centered row of badges. GitHub lays these out side by side at their declared size,
// which the Markdown engine cannot do, so they render outside it.
const ROW_TAGS = new Set(["table", "tr", "p", "div", "center", "br"]);
const CELL_TAGS = new Set(["thead", "tbody", "tfoot", "td", "th", "a", "picture", "source"]);
const VOID_TAGS = new Set(["img", "br", "source"]);

/** Split top-level HTML image blocks out of a Markdown document. */
export function splitHtmlImageBlocks(source: string): MarkdownBlock[] {
  if (!/<img\b/i.test(source)) return [{ kind: "markdown", id: "0", source }];
  const tree = fromMarkdown(source);
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  const pushMarkdown = (end: number) => {
    const text = source.slice(cursor, end);
    if (text.trim()) blocks.push({ kind: "markdown", id: String(blocks.length), source: text });
  };
  for (const node of tree.children) {
    if (node.type !== "html" || !node.position) continue;
    const rows = parseHtmlImageRows(node.value);
    if (!rows) continue;
    pushMarkdown(node.position.start.offset!);
    blocks.push({ kind: "images", id: String(blocks.length), rows });
    cursor = node.position.end.offset!;
  }
  if (blocks.length === 0) return [{ kind: "markdown", id: "0", source }];
  pushMarkdown(source.length);
  // Each fragment parses on its own, so give every one the document's link definitions.
  const definitions = referenceDefinitionSource(tree);
  if (definitions)
    for (const block of blocks) {
      if (block.kind === "markdown") block.source = `${definitions}\n\n${block.source}`;
    }
  return blocks;
}

function parseHtmlImageRows(html: string): HtmlImageRow[] | null {
  const rows: HtmlImageRow[] = [];
  const aligns: (HtmlImageRow["align"] | undefined)[] = [];
  const links: (string | undefined)[] = [];
  let row: HtmlImageRow | null = null;
  let valid = true;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "img") {
          if (!attributes.src) {
            valid = false;
            return;
          }
          if (!row) {
            row = {
              id: String(rows.length),
              align: aligns.findLast(Boolean) ?? "left",
              images: [],
            };
            rows.push(row);
          }
          row.images.push({
            id: String(row.images.length),
            src: attributes.src,
            alt: attributes.alt ?? "",
            ...(links.at(-1) ? { href: links.at(-1) } : {}),
            ...dimension("width", attributes.width),
            ...dimension("height", attributes.height),
          });
          return;
        }
        if (!ROW_TAGS.has(name) && !CELL_TAGS.has(name)) valid = false;
        if (ROW_TAGS.has(name)) row = null;
        if (VOID_TAGS.has(name)) return;
        aligns.push(name === "center" ? "center" : alignment(attributes.align));
        links.push(name === "a" ? attributes.href : links.at(-1));
      },
      onclosetag(name) {
        if (VOID_TAGS.has(name)) return;
        if (ROW_TAGS.has(name)) row = null;
        aligns.pop();
        links.pop();
      },
      ontext(text) {
        if (text.trim()) valid = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.end(html);
  return valid && rows.length > 0 ? rows : null;
}

function alignment(value: string | undefined): HtmlImageRow["align"] | undefined {
  const align = value?.trim().toLowerCase();
  return align === "center" || align === "right" || align === "left" ? align : undefined;
}

function dimension(key: "width" | "height", value: string | undefined) {
  const match = value ? /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(value) : null;
  const parsed = match ? Number(match[1]) : 0;
  return parsed > 0 ? { [key]: parsed } : {};
}

// Block images in the Markdown engine are 320 tall; undeclared images stay within that.
const UNDECLARED_MAX_HEIGHT = 320;

/** Width and aspect ratio of an HTML image, from its attributes and, once decoded, its pixels. */
export function htmlImageBox(
  image: Pick<HtmlImage, "width" | "height">,
  natural: { width: number; height: number } | undefined,
): { width: number; aspectRatio: number } {
  const ratio = natural ? natural.width / natural.height : undefined;
  if (image.width && image.height)
    return { width: image.width, aspectRatio: image.width / image.height };
  if (image.width) return { width: image.width, aspectRatio: ratio ?? 1 };
  if (image.height) return { width: image.height * (ratio ?? 1), aspectRatio: ratio ?? 1 };
  if (natural && ratio)
    return {
      width: natural.width * Math.min(1, UNDECLARED_MAX_HEIGHT / natural.height),
      aspectRatio: ratio,
    };
  return { width: 0, aspectRatio: 1 };
}
