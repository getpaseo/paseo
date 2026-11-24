import { CharCategory, EditorState } from "@codemirror/state";
import { graphemeBoundaries } from "./model";

export interface SourceWordRange {
  start: number;
  end: number;
}

interface SourceText {
  state: EditorState;
  boundaries: number[];
  categorize: (cluster: string) => CharCategory;
}

// Word gestures query the same line repeatedly while dragging. Keep a bounded
// set of parsed sources instead of rebuilding an EditorState on every move.
const SOURCE_CACHE_LIMIT = 8;
const sources = new Map<string, SourceText>();

/**
 * The run around `offset` that a double click selects: a word, a run of
 * whitespace, or a run of punctuation. Runs never cross grapheme boundaries.
 */
export function wordRangeAtOffset(content: string, offset: number): SourceWordRange {
  if (content.length === 0) return { start: 0, end: 0 };
  const source = sourceText(content);
  const { boundaries } = source;
  const clusterIndex = clusterIndexAt(boundaries, offset);
  const category = source.categorize(clusterText(content, boundaries, clusterIndex));
  if (category === CharCategory.Word) {
    const word = source.state.wordAt(boundaries[clusterIndex]);
    if (word) return { start: word.from, end: word.to };
  }
  let first = clusterIndex;
  while (first > 0 && categoryAt(source, content, boundaries, first - 1) === category) first -= 1;
  let last = clusterIndex;
  while (
    last < boundaries.length - 2 &&
    categoryAt(source, content, boundaries, last + 1) === category
  )
    last += 1;
  return { start: boundaries[first], end: boundaries[last + 1] };
}

function sourceText(content: string): SourceText {
  const cached = sources.get(content);
  if (cached) {
    sources.delete(content);
    sources.set(content, cached);
    return cached;
  }
  const state = EditorState.create({ doc: content });
  const source: SourceText = {
    state,
    boundaries: graphemeBoundaries(content),
    categorize: state.charCategorizer(0),
  };
  sources.set(content, source);
  if (sources.size > SOURCE_CACHE_LIMIT) {
    const oldest = sources.keys().next();
    if (!oldest.done) sources.delete(oldest.value);
  }
  return source;
}

function clusterIndexAt(boundaries: readonly number[], offset: number): number {
  let low = 0;
  let high = boundaries.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (boundaries[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function categoryAt(
  source: SourceText,
  content: string,
  boundaries: readonly number[],
  index: number,
): CharCategory {
  return source.categorize(clusterText(content, boundaries, index));
}

function clusterText(content: string, boundaries: readonly number[], index: number): string {
  return content.slice(boundaries[index], boundaries[index + 1]);
}
