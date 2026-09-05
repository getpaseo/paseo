import { MARKDOWN_COPY_IGNORE_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { FIND_IGNORE_ATTRIBUTE } from "./markers";

export interface FindTextRangesInput {
  /** Containers to search. A match may span text nodes and elements inside one root. */
  roots: readonly Element[];
  query: string;
}

/**
 * A root's folded text plus, for every folded code unit, the text node and the bounds
 * of the source character it came from.
 *
 * Folding is per code point and can change length (see `foldFindText`), so a match
 * index in `folded` says nothing about an offset in the DOM without this map. A match
 * that starts or ends inside an expanded fold pins the whole source character, which is
 * the only thing a Range can express.
 */
interface FoldedText {
  folded: string;
  nodes: Text[];
  starts: number[];
  ends: number[];
}

/**
 * Every case-insensitive literal occurrence of `query` under `roots`, as DOM Ranges.
 *
 * Matches are found against each root's flattened text, so a match that crosses the
 * `<span>` boundaries the markdown renderer emits still produces one range. Matches
 * never cross roots: two adjacent messages are two searches.
 */
export function findTextRanges({ roots, query }: FindTextRangesInput): Range[] {
  if (query === "") {
    return [];
  }
  const needle = foldFindText(query);
  return roots.flatMap((root) => rangesInRoot(root, needle));
}

function rangesInRoot(root: Element, needle: string): Range[] {
  const text = foldTextNodes(collectTextNodes(root));

  const ranges: Range[] = [];
  let index = text.folded.indexOf(needle);
  while (index !== -1) {
    const last = index + needle.length - 1;
    const range = root.ownerDocument.createRange();
    range.setStart(text.nodes[index], text.starts[index]);
    range.setEnd(text.nodes[last], text.ends[last]);
    ranges.push(range);
    // Non-overlapping, the way a browser's own find behaves.
    index = text.folded.indexOf(needle, index + needle.length);
  }
  return ranges;
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE"]);

function collectTextNodes(root: Element): Text[] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!(node instanceof Element)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        const ignored =
          SKIPPED_TAGS.has(node.tagName) ||
          node.getAttribute(MARKDOWN_COPY_IGNORE_ATTRIBUTE) === "true" ||
          node.getAttribute(FIND_IGNORE_ATTRIBUTE) === "true";
        return ignored ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    },
  );

  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && node.data !== "") {
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * Builds the haystack and its offset map in one pass, character by character.
 *
 * The Markdown preview hands the engine one root holding the whole document and this
 * reruns on every keystroke, so it stays linear in the text: no scan or binary search
 * over nodes per match, one map entry per folded code unit.
 */
function foldTextNodes(nodes: readonly Text[]): FoldedText {
  let folded = "";
  const sources: Text[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const node of nodes) {
    let offset = 0;
    for (const char of node.data) {
      const end = offset + char.length;
      const lower = char.toLowerCase();
      folded += lower;
      for (let unit = 0; unit < lower.length; unit += 1) {
        sources.push(node);
        starts.push(offset);
        ends.push(end);
      }
      offset = end;
    }
  }
  return { folded, nodes: sources, starts, ends };
}

/**
 * Case folding, one code point at a time.
 *
 * Lowercasing a whole string applies context-sensitive rules — a final Greek sigma
 * folds differently from a medial one — and the DOM walk sees text split across
 * arbitrary node boundaries, so only a per-code-point fold gives the same answer as
 * folding the transcript's projection of the same text. The price is that a query
 * typed with a final sigma does not match a medial one, and vice versa.
 *
 * The fold can change length: Turkish dotted capital İ becomes "i" plus a combining
 * dot, so "İstanbul" is found by that spelling and not by a plain "istanbul". Callers
 * that need DOM offsets back must carry a map (see `FoldedText`); the transcript index
 * only counts, so the folded string is all it needs.
 *
 * Exported because the transcript counts matches against a text projection of the
 * loaded stream items rather than the DOM; the two only agree if they fold alike.
 */
export function foldFindText(text: string): string {
  let folded = "";
  for (const char of text) {
    folded += char.toLowerCase();
  }
  return folded;
}
