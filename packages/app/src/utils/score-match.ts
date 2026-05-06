export interface MatchScore {
  tier: number;
  offset: number;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[a-z0-9]/.test(ch);
}

export function scoreMatch(query: string, text: string): MatchScore | null {
  if (!query) return { tier: 0, offset: 0 };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return { tier: 0, offset: 0 };

  let best: MatchScore | null = null;
  let pos = 0;
  while (pos <= t.length - q.length) {
    const found = t.indexOf(q, pos);
    if (found === -1) break;
    const before = found > 0 ? t[found - 1] : undefined;
    const after = t[found + q.length];
    const startsAtBoundary = found === 0 || isWordBoundaryChar(before);
    const endsAtBoundary = after === undefined || isWordBoundaryChar(after);
    let tier: number;
    if (startsAtBoundary && endsAtBoundary) {
      tier = 1;
    } else if (found === 0) {
      tier = 2;
    } else if (startsAtBoundary) {
      tier = 3;
    } else {
      tier = 4;
    }
    if (!best || tier < best.tier || (tier === best.tier && found < best.offset)) {
      best = { tier, offset: found };
    }
    pos = found + 1;
  }
  return best;
}

export function compareMatchScores(a: MatchScore, b: MatchScore): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return a.offset - b.offset;
}
