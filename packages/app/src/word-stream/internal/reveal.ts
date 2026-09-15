/**
 * A run of characters that is still fading in.
 *
 * Character j of n in the run starts fading at `startedAt + spanMs * j / n`
 * and takes FADE_DURATION_MS to reach full opacity. Runs are ordered by source
 * position and their start times never decrease along that order, so at any
 * instant opacity is non-increasing in reading order: one front, not a fade
 * per word.
 */
export interface FadeRange {
  start: number;
  end: number;
  startedAt: number;
  spanMs: number;
}
export const FADE_DURATION_MS = 150;

function settled(range: FadeRange, now: number): boolean {
  return now - (range.startedAt + range.spanMs) >= FADE_DURATION_MS;
}

/** Message-owned reveal history survives changes in Markdown/view structure. */
export class Reveal {
  private constructor(
    readonly text: string,
    readonly ranges: readonly FadeRange[],
  ) {}
  static begin(text: string): Reveal {
    return new Reveal(text, []);
  }
  /**
   * `spanMs` is how long the newly arrived text owns the front before the next
   * release. When several words arrive together they share it in order.
   */
  receive(text: string, now: number, spanMs: number): Reveal {
    if (text === this.text) return this;
    if (!text.startsWith(this.text)) return Reveal.begin(text);
    const ranges = this.ranges.filter((range) => !settled(range, now));
    const words = Array.from(text.slice(this.text.length).matchAll(/\S+/gu));
    if (words.length === 0) return new Reveal(text, ranges);
    // A frame that arrives early must continue the front, never overtake it.
    const previous = ranges.at(-1);
    const base = Math.max(now, previous ? previous.startedAt + previous.spanMs : now);
    const share = spanMs / words.length;
    words.forEach((word, index) => {
      const start = this.text.length + word.index;
      ranges.push({
        start,
        end: start + word[0].length,
        startedAt: base + share * index,
        spanMs: share,
      });
    });
    return new Reveal(text, ranges);
  }
  surface(text: string, offsets: readonly number[], now: number): FadeRange[] {
    const result: FadeRange[] = [];
    let first = 0;
    let last = offsets.length - 1;
    while (first <= last && offsets[first]! < 0) first++;
    while (last >= first && offsets[last]! < 0) last--;
    for (const range of this.ranges) {
      if (
        settled(range, now) ||
        first > last ||
        range.end <= offsets[first]! ||
        range.start > offsets[last]!
      )
        continue;
      const perSourceChar = range.spanMs / (range.end - range.start);
      let start = -1;
      for (let i = 0; i <= offsets.length; i++) {
        const inside =
          i < offsets.length &&
          offsets[i]! >= range.start &&
          offsets[i]! < range.end &&
          !/\s/u.test(text[i]!);
        if (inside && start < 0) start = i;
        if (!inside && start >= 0) {
          // A rendered piece keeps the slice of the word's timeline it came from,
          // so a word split by inline formatting still fades as one run.
          const from = offsets[start]! - range.start;
          const to = offsets[i - 1]! + 1 - range.start;
          result.push({
            start,
            end: i,
            startedAt: range.startedAt + perSourceChar * from,
            spanMs: perSourceChar * (to - from),
          });
          start = -1;
        }
      }
    }
    return result;
  }
}
