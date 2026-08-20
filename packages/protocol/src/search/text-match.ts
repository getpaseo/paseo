/**
 * Ranked text matching shared by the app's pickers and the daemon's history
 * search. A match is a tier plus the offset it was found at; lower is better on
 * both, so callers sort ascending and never have to invent a scale.
 *
 * Typo tolerance is opt-in via `fuzzy`. The pickers leave it off — a combobox
 * over a known list wants exact narrowing — while history search turns it on
 * because the user is recalling a title from memory.
 */

export interface MatchScore {
  tier: number;
  offset: number;
  spread?: number;
}

export interface MatchOptions {
  /** Omit or pass null to match exactly. `fuzzyPolicyForToken` picks a policy. */
  fuzzy?: FuzzyPolicy | null;
}

/** Exact tiers, best to worst. The fuzzy tier always sorts after all of them. */
const TIER_EXACT = 0;
const TIER_WHOLE_WORD = 1;
const TIER_PREFIX = 2;
const TIER_WORD_START = 3;
const TIER_SUBSTRING = 4;
const TIER_SUBSEQUENCE = 5;
const TIER_FUZZY = 6;

function isWordBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[a-z0-9]/.test(ch);
}

function scoreSubstringMatch(query: string, text: string): MatchScore | null {
  let best: MatchScore | null = null;
  let pos = 0;
  while (pos <= text.length - query.length) {
    const found = text.indexOf(query, pos);
    if (found === -1) break;
    const before = found > 0 ? text[found - 1] : undefined;
    const after = text[found + query.length];
    const startsAtBoundary = found === 0 || isWordBoundaryChar(before);
    const endsAtBoundary = after === undefined || isWordBoundaryChar(after);
    let tier: number;
    if (startsAtBoundary && endsAtBoundary) {
      tier = TIER_WHOLE_WORD;
    } else if (found === 0) {
      tier = TIER_PREFIX;
    } else if (startsAtBoundary) {
      tier = TIER_WORD_START;
    } else {
      tier = TIER_SUBSTRING;
    }
    if (!best || tier < best.tier || (tier === best.tier && found < best.offset)) {
      best = { tier, offset: found };
    }
    pos = found + 1;
  }
  return best;
}

function scoreSubsequenceMatch(query: string, text: string): MatchScore | null {
  let queryIndex = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] !== query[queryIndex]) continue;
    if (firstIndex === -1) firstIndex = textIndex;
    lastIndex = textIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length || firstIndex === -1) return null;
  return { tier: TIER_SUBSEQUENCE, offset: firstIndex, spread: lastIndex - firstIndex + 1 };
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as every cell in a row is
 * over budget. Bounding it is what keeps the fuzzy tier affordable to run
 * against every word of every candidate.
 */
function boundedEditDistance(query: string, word: string, budget: number): number | null {
  if (Math.abs(query.length - word.length) > budget) return null;

  let twoRowsBack: number[] = [];
  let previousRow: number[] = Array.from({ length: word.length + 1 }, (_, index) => index);

  for (let queryIndex = 1; queryIndex <= query.length; queryIndex += 1) {
    const currentRow = [queryIndex];
    let rowBest = queryIndex;
    for (let wordIndex = 1; wordIndex <= word.length; wordIndex += 1) {
      const substitutionCost = query[queryIndex - 1] === word[wordIndex - 1] ? 0 : 1;
      let cost = Math.min(
        currentRow[wordIndex - 1] + 1,
        previousRow[wordIndex] + 1,
        previousRow[wordIndex - 1] + substitutionCost,
      );
      const isTransposition =
        queryIndex > 1 &&
        wordIndex > 1 &&
        query[queryIndex - 1] === word[wordIndex - 2] &&
        query[queryIndex - 2] === word[wordIndex - 1];
      if (isTransposition) {
        cost = Math.min(cost, twoRowsBack[wordIndex - 2] + 1);
      }
      currentRow.push(cost);
      rowBest = Math.min(rowBest, cost);
    }
    if (rowBest > budget) return null;
    twoRowsBack = previousRow;
    previousRow = currentRow;
  }

  const distance = previousRow[word.length];
  return distance <= budget ? distance : null;
}

function transpositionDistance(query: string, word: string): number | null {
  return isAdjacentTransposition(query, word) ? 1 : null;
}

/** True when the two differ only by one swap of neighbouring characters. */
function isAdjacentTransposition(query: string, word: string): boolean {
  if (query.length !== word.length) return false;
  let index = 0;
  while (index < query.length && query[index] === word[index]) index += 1;
  if (index >= query.length - 1) return false;
  if (query[index] !== word[index + 1] || query[index + 1] !== word[index]) return false;
  return query.slice(index + 2) === word.slice(index + 2);
}

/**
 * How much a typo in one query token is forgiven. Short tokens get
 * transpositions and nothing else: at four characters a free substitution turns
 * "main" into "mail", "maid", and "rain", while a swap can only ever reach the
 * word the user meant. Null means the token is matched exactly.
 */
export interface FuzzyPolicy {
  maxEdits: number;
  transpositionsOnly: boolean;
}

export function fuzzyPolicyForToken(token: string): FuzzyPolicy | null {
  if (token.length <= 3) return null;
  if (token.length === 4) return { maxEdits: 1, transpositionsOnly: true };
  if (token.length <= 7) return { maxEdits: 1, transpositionsOnly: false };
  return { maxEdits: 2, transpositionsOnly: false };
}

/**
 * Words are what people mistype, so the fuzzy tier compares the query against
 * each word rather than against the whole string — otherwise a long title's
 * length difference alone would blow the budget.
 */
function scoreFuzzyMatch(query: string, text: string, policy: FuzzyPolicy): MatchScore | null {
  if (policy.maxEdits <= 0 || query.length <= policy.maxEdits) return null;

  let best: MatchScore | null = null;
  const wordPattern = /[a-z0-9]+/g;
  let word = wordPattern.exec(text);
  while (word !== null) {
    // Compare against the whole word and against its leading slices, so a typo
    // in a prefix ("confug" for "configuration") still lands — the length gap
    // to the full word would otherwise blow the budget on its own.
    const candidates = new Set([
      word[0],
      word[0].slice(0, query.length),
      word[0].slice(0, query.length + policy.maxEdits),
    ]);
    for (const candidate of candidates) {
      const distance = policy.transpositionsOnly
        ? transpositionDistance(query, candidate)
        : boundedEditDistance(query, candidate, policy.maxEdits);
      if (distance === null) continue;
      const score: MatchScore = { tier: TIER_FUZZY, offset: word.index, spread: distance };
      if (!best || compareMatchScores(score, best) < 0) {
        best = score;
      }
    }
    word = wordPattern.exec(text);
  }
  return best;
}

export function scoreMatch(
  query: string,
  text: string,
  options: MatchOptions = {},
): MatchScore | null {
  if (!query) return { tier: TIER_EXACT, offset: 0 };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return { tier: TIER_EXACT, offset: 0 };

  const exact = scoreSubstringMatch(q, t) ?? scoreSubsequenceMatch(q, t);
  if (exact) return exact;

  const fuzzy = options.fuzzy;
  return fuzzy ? scoreFuzzyMatch(q, t, fuzzy) : null;
}

interface CompactText {
  value: string;
  offsets: number[];
}

function compactText(value: string): CompactText {
  let compact = "";
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!/[a-z0-9]/i.test(value[index])) continue;
    compact += value[index].toLowerCase();
    offsets.push(index);
  }
  return { value: compact, offsets };
}

/** Match a query against a complete displayed path, including its separators. */
export function scorePathMatch(query: string, path: string): MatchScore | null {
  const direct = scoreMatch(query, path);
  if (direct) return direct;

  const compactQuery = compactText(query);
  const compactPath = compactText(path);
  if (!compactQuery.value || !compactPath.value) return null;

  const compactScore = scoreMatch(compactQuery.value, compactPath.value);
  if (!compactScore) return null;
  return {
    ...compactScore,
    offset: compactPath.offsets[compactScore.offset] ?? compactScore.offset,
  };
}

export interface MatchRange {
  start: number;
  length: number;
}

function mergeAdjacentRanges(indices: readonly number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const index of indices) {
    const last = ranges.at(-1);
    if (last && last.start + last.length === index) {
      last.length += 1;
      continue;
    }
    ranges.push({ start: index, length: 1 });
  }
  return ranges;
}

function wordRangeAt(text: string, offset: number): MatchRange {
  let end = offset;
  while (end < text.length && /[a-z0-9]/.test(text[end])) end += 1;
  return { start: offset, length: Math.max(end - offset, 1) };
}

/**
 * Where a score's match actually landed, so a caller can mark it. Derived from
 * a score rather than produced alongside one: ranking touches every candidate
 * and needs no ranges, while only the handful of rows that get rendered do.
 *
 * The tier decides the shape. A substring hit is one span; a subsequence hit is
 * the scattered characters it walked; a typo hit marks the whole word, because
 * the characters the user got wrong are not in the text to point at.
 */
export function matchRanges(query: string, text: string, score: MatchScore): MatchRange[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (score.tier === TIER_EXACT) return [{ start: 0, length: text.length }];
  if (score.tier === TIER_FUZZY) return [wordRangeAt(t, score.offset)];
  if (score.tier === TIER_SUBSEQUENCE) {
    const indices: number[] = [];
    let queryIndex = 0;
    for (let textIndex = 0; textIndex < t.length && queryIndex < q.length; textIndex += 1) {
      if (t[textIndex] !== q[queryIndex]) continue;
      indices.push(textIndex);
      queryIndex += 1;
    }
    return mergeAdjacentRanges(indices);
  }
  return [{ start: score.offset, length: q.length }];
}

export function compareMatchScores(a: MatchScore, b: MatchScore): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return (a.spread ?? 0) - (b.spread ?? 0);
}

export function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export interface TextFieldsOptions {
  /**
   * Forgive typos. The budget is per token rather than per query, because a
   * query mixes long words that can absorb an edit with short ones that cannot.
   */
  typoTolerant?: boolean;
}

export function scoreTextFields(
  query: string,
  fields: string[],
  options: TextFieldsOptions = {},
): MatchScore | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return { tier: TIER_EXACT, offset: 0, spread: 0 };

  const aggregate: MatchScore = { tier: TIER_EXACT, offset: 0, spread: 0 };
  for (const token of tokens) {
    const fuzzy = options.typoTolerant ? fuzzyPolicyForToken(token) : null;
    let best: MatchScore | null = null;
    for (const field of fields) {
      const score = scoreMatch(token, field, { fuzzy });
      if (score && (!best || compareMatchScores(score, best) < 0)) {
        best = score;
      }
    }
    if (!best) return null;
    aggregate.tier += best.tier;
    aggregate.offset += best.offset;
    aggregate.spread = (aggregate.spread ?? 0) + (best.spread ?? token.length);
  }
  return aggregate;
}
