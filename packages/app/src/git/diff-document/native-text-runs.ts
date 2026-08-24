import { fragmentTextForRange } from "./model";
import type { DiffCell, DiffFragment } from "./types";

export interface NativeTextRun {
  color: string;
  left: number;
  text: string;
}

/** Converts syntax ranges into disjoint positioned runs so native paints every glyph once. */
export function nativeTextRuns(cell: DiffCell, fragment: DiffFragment): NativeTextRun[] {
  "worklet";
  return cell.tokens.flatMap((token) => {
    const start = Math.max(fragment.start, token.start);
    const end = Math.min(fragment.end, token.end);
    if (end <= start) return [];
    let left = 0;
    for (const grapheme of fragment.graphemes) {
      if (grapheme.end <= start) left += grapheme.width;
    }
    return [{ color: token.color, left, text: fragmentTextForRange(fragment, start, end) }];
  });
}
