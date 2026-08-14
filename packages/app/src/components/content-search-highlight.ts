/** Split a line into plain/highlighted segments around every case-insensitive
 *  occurrence of the query, for content-search result rows. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const segments: HighlightSegment[] = [];
  let idx = 0;
  if (q.length > 0) {
    while (true) {
      const at = lower.indexOf(q, idx);
      if (at === -1) break;
      if (at > idx) segments.push({ text: text.slice(idx, at), hit: false });
      segments.push({ text: text.slice(at, at + q.length), hit: true });
      idx = at + q.length;
    }
  }
  if (idx < text.length) segments.push({ text: text.slice(idx), hit: false });
  return segments;
}
