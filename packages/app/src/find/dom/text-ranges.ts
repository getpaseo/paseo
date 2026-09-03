import { MARKDOWN_COPY_IGNORE_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { FIND_IGNORE_ATTRIBUTE } from "./markers";

export interface FindTextRangesInput {
  /** Containers to search. A match may span text nodes and elements inside one root. */
  roots: readonly Element[];
  query: string;
}

interface TextSegment {
  node: Text;
  /** Where this node's text starts and ends inside the root's flattened text. */
  start: number;
  end: number;
}

interface TextPosition {
  node: Text;
  offset: number;
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
  const segments = collectTextSegments(root);
  const haystack = segments.map((segment) => foldFindText(segment.node.data)).join("");

  const ranges: Range[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const start = locateStart(segments, index);
    const end = locateEnd(segments, index + needle.length);
    const range = root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
    // Non-overlapping, the way a browser's own find behaves.
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE"]);

function collectTextSegments(root: Element): TextSegment[] {
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

  const segments: TextSegment[] = [];
  let length = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.data === "") {
      continue;
    }
    segments.push({ node, start: length, end: length + node.data.length });
    length = length + node.data.length;
  }
  return segments;
}

/**
 * The start boundary belongs to the node the character at `index` lives in; the end
 * boundary belongs to the node the last matched character lives in. Splitting the two
 * keeps a range that ends on a node boundary from starting in the node before it, which
 * is why the two predicates differ on the `end == index` case.
 */
function locateStart(segments: readonly TextSegment[], index: number): TextPosition {
  const segment = firstSegment(segments, (candidate) => index < candidate.end);
  if (!segment) {
    throw new Error("Find match starts past the searched text");
  }
  return { node: segment.node, offset: index - segment.start };
}

function locateEnd(segments: readonly TextSegment[], index: number): TextPosition {
  const segment = firstSegment(segments, (candidate) => index <= candidate.end);
  if (!segment) {
    throw new Error("Find match ends past the searched text");
  }
  return { node: segment.node, offset: index - segment.start };
}

/**
 * The first segment the predicate accepts, found by halving rather than scanning.
 *
 * `segments` is ordered by `end`, so both locate predicates are false for a prefix of
 * the list and true for the rest. Scanning from the front instead cost O(matches x text
 * nodes) per recompute, and the Markdown preview hands the engine one root holding the
 * whole document: a one-character query in a large README ran that on every keystroke.
 */
function firstSegment(
  segments: readonly TextSegment[],
  accepts: (segment: TextSegment) => boolean,
): TextSegment | undefined {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (accepts(segments[middle])) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return segments[low];
}

/**
 * Case folding that never changes a string's length, so a match index maps straight
 * back onto text-node offsets. The few characters whose lowercase form is longer
 * (Turkish dotted capital I, for one) keep their original form and simply do not
 * match their lowercase spelling.
 *
 * Exported because the transcript counts matches against a text projection of the
 * loaded stream items rather than the DOM; the two only agree if they fold alike.
 */
export function foldFindText(text: string): string {
  let folded = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}
