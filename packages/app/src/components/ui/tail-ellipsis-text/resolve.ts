const ELLIPSIS = "…";

/**
 * The word-boundary truncations of `text`, shortest first: "Ten second stream" gives "Ten…" and
 * "Ten second…". Cutting at a word keeps whitespace out from before the ellipsis.
 */
export function tailEllipsisCandidates(text: string): string[] {
  const words = text.trim().split(/\s+/);
  return words.slice(1).map((_, index) => `${words.slice(0, index + 1).join(" ")}${ELLIPSIS}`);
}

export type TailEllipsis =
  | { kind: "measuring" }
  | { kind: "full" }
  | { kind: "truncated"; text: string }
  /** Not even the first word fits: the platform ellipsis cuts inside it, where no space can sit. */
  | { kind: "clipped" };

/** Widths in points, measured from the rendered text. */
export interface TailEllipsisMeasurements {
  /** The space the text may take, up to its full width. */
  boxWidth?: number;
  fullWidth?: number;
  /** One per `tailEllipsisCandidates` entry, in the same order. */
  candidateWidths: readonly (number | undefined)[];
}

/** Sub-point slack for widths the layout rounds differently from the text it measures. */
const ROUNDING_SLACK = 0.5;

export function resolveTailEllipsis(input: {
  candidates: readonly string[];
  measurements: TailEllipsisMeasurements;
}): TailEllipsis {
  const { boxWidth, fullWidth, candidateWidths } = input.measurements;
  if (boxWidth === undefined || fullWidth === undefined) return { kind: "measuring" };
  if (fullWidth <= boxWidth + ROUNDING_SLACK) return { kind: "full" };
  if (input.candidates.some((_, index) => candidateWidths[index] === undefined)) {
    return { kind: "measuring" };
  }
  for (let index = input.candidates.length - 1; index >= 0; index -= 1) {
    if ((candidateWidths[index] ?? Infinity) <= boxWidth) {
      return { kind: "truncated", text: input.candidates[index] };
    }
  }
  return { kind: "clipped" };
}
