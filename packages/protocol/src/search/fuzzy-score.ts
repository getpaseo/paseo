/**
 * VSCode's fuzzy scorer, ported for the file picker.
 *
 * Source: microsoft/vscode `src/vs/base/common/filters.ts` (`fuzzyScore` and `_doScore`),
 * MIT licensed. Kept behaviourally identical on purpose: the picker should rank the same
 * way `Cmd+P` does in VSCode, so a query like `chi` puts `chat-input.tsx` above
 * `architecture.ts`. Do not "improve" the scoring here without a test that shows the
 * VSCode ordering changed too.
 *
 * The score rewards, in order: a matching prefix, a camel-case or separator boundary,
 * a contiguous run, and an early match. It penalizes gaps. A first pattern character
 * that lands mid-word (not at a boundary) rejects the match outright, which is why
 * `index` finds `my-index.ts` but not `myindex.ts` for the wrong reason.
 */

/** VSCode caps both strings at 128 code units; keep the same tables sized for that. */
const MAX_LEN = 128;
const NO_SCORE = Number.MIN_SAFE_INTEGER;

function newTable(): number[][] {
  return Array.from({ length: MAX_LEN + 1 }, () => Array.from({ length: MAX_LEN + 1 }, () => 0));
}

const table = newTable();
const diag = newTable();
const arrows = Array.from({ length: MAX_LEN + 1 }, () =>
  Array.from({ length: MAX_LEN + 1 }, () => 0),
);
const minWordMatchPos = new Int32Array(2 * MAX_LEN);
const maxWordMatchPos = new Int32Array(2 * MAX_LEN);

const ARROW_DIAG = 1;
const ARROW_LEFT = 2;
const ARROW_LEFT_LEFT = 3;

const SEPARATORS = new Set([
  "_",
  "-",
  ".",
  " ",
  "/",
  "\\",
  "'",
  '"',
  ":",
  "$",
  "<",
  ">",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
]);

function isSeparatorAtPos(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  return SEPARATORS.has(value[index]);
}

function isWhitespaceAtPos(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  const code = value.charCodeAt(index);
  return code === 32 || code === 9;
}

function isUpperCaseAtPos(pos: number, word: string, wordLow: string): boolean {
  return word[pos] !== wordLow[pos];
}

function isPatternInWord(
  patternLow: string,
  patternPos: number,
  patternLen: number,
  wordLow: string,
  wordPos: number,
  wordLen: number,
): boolean {
  while (patternPos < patternLen && wordPos < wordLen) {
    if (patternLow[patternPos] === wordLow[wordPos]) {
      minWordMatchPos[patternPos] = wordPos;
      patternPos += 1;
    }
    wordPos += 1;
  }
  return patternPos === patternLen;
}

function fillInMaxWordMatchPos(
  patternLen: number,
  wordLen: number,
  patternStart: number,
  wordStart: number,
  patternLow: string,
  wordLow: string,
): void {
  let patternPos = patternLen - 1;
  let wordPos = wordLen - 1;
  while (patternPos >= patternStart && wordPos >= wordStart) {
    if (patternLow[patternPos] === wordLow[wordPos]) {
      maxWordMatchPos[patternPos] = wordPos;
      patternPos -= 1;
    }
    wordPos -= 1;
  }
}

/** Score one matched character, given where it sits in the word. */
// eslint-disable-next-line complexity -- Ported branch-for-branch from VSCode; see file header.
function scoreChar(
  pattern: string,
  patternLow: string,
  patternPos: number,
  patternStart: number,
  word: string,
  wordLow: string,
  wordPos: number,
  wordLen: number,
  wordStart: number,
  newMatchStart: boolean,
  outFirstMatchStrong: boolean[],
): number {
  if (patternLow[patternPos] !== wordLow[wordPos]) return NO_SCORE;

  let score = 1;
  let isGapLocation = false;
  if (wordPos === patternPos - patternStart) {
    // Common prefix: `foobar <-> foobaz`.
    score = pattern[patternPos] === word[wordPos] ? 7 : 5;
  } else if (
    isUpperCaseAtPos(wordPos, word, wordLow) &&
    (wordPos === 0 || !isUpperCaseAtPos(wordPos - 1, word, wordLow))
  ) {
    // Camel-case boundary.
    score = pattern[patternPos] === word[wordPos] ? 7 : 5;
    isGapLocation = true;
  } else if (
    isSeparatorAtPos(wordLow, wordPos) &&
    (wordPos === 0 || !isSeparatorAtPos(wordLow, wordPos - 1))
  ) {
    // Hitting a separator.
    score = 5;
  } else if (isSeparatorAtPos(wordLow, wordPos - 1) || isWhitespaceAtPos(wordLow, wordPos - 1)) {
    // First character after a separator.
    score = 5;
    isGapLocation = true;
  }

  if (score > 1 && patternPos === patternStart) outFirstMatchStrong[0] = true;

  if (!isGapLocation) {
    isGapLocation =
      isUpperCaseAtPos(wordPos, word, wordLow) ||
      isSeparatorAtPos(wordLow, wordPos - 1) ||
      isWhitespaceAtPos(wordLow, wordPos - 1);
  }

  if (patternPos === patternStart) {
    // A first match away from the word start pays for the skipped prefix.
    if (wordPos > wordStart) score -= isGapLocation ? 3 : 5;
  } else if (newMatchStart) {
    score += isGapLocation ? 2 : 0;
  } else {
    score += isGapLocation ? 0 : 1;
  }

  if (wordPos + 1 === wordLen) {
    // Normalize the advantage of matching the last character.
    score -= isGapLocation ? 3 : 5;
  }

  return score;
}

/**
 * Score `pattern` against `word`. Higher is better. Returns null when the characters
 * do not appear in order, or when the first match is weak (mid-word, no boundary).
 */
// eslint-disable-next-line complexity -- Ported branch-for-branch from VSCode; see file header.
export function fuzzyScore(pattern: string, word: string): number | null {
  if (!pattern) return 0;
  if (pattern.length > word.length) return null;

  const patternLen = Math.min(pattern.length, MAX_LEN);
  const wordLen = Math.min(word.length, MAX_LEN);
  const patternLow = pattern.slice(0, patternLen).toLowerCase();
  const wordLow = word.slice(0, wordLen).toLowerCase();

  if (!isPatternInWord(patternLow, 0, patternLen, wordLow, 0, wordLen)) return null;
  fillInMaxWordMatchPos(patternLen, wordLen, 0, 0, patternLow, wordLow);

  const hasStrongFirstMatch = [false];

  for (let row = 1, patternPos = 0; patternPos < patternLen; row += 1, patternPos += 1) {
    const minPos = minWordMatchPos[patternPos];
    const maxPos = maxWordMatchPos[patternPos];
    const nextMaxPos = patternPos + 1 < patternLen ? maxWordMatchPos[patternPos + 1] : wordLen;

    for (
      let column = minPos + 1, wordPos = minPos;
      wordPos < nextMaxPos;
      column += 1, wordPos += 1
    ) {
      let score = NO_SCORE;
      let canComeDiag = false;

      if (wordPos <= maxPos) {
        score = scoreChar(
          pattern,
          patternLow,
          patternPos,
          0,
          word,
          wordLow,
          wordPos,
          wordLen,
          0,
          diag[row - 1][column - 1] === 0,
          hasStrongFirstMatch,
        );
      }

      let diagScore = 0;
      if (score !== NO_SCORE) {
        canComeDiag = true;
        diagScore = score + table[row - 1][column - 1];
      }

      const canComeLeft = wordPos > minPos;
      const leftScore = canComeLeft
        ? table[row][column - 1] + (diag[row][column - 1] > 0 ? -5 : 0)
        : 0;

      const canComeLeftLeft = wordPos > minPos + 1 && diag[row][column - 1] > 0;
      const leftLeftScore = canComeLeftLeft
        ? table[row][column - 2] + (diag[row][column - 2] > 0 ? -5 : 0)
        : 0;

      if (
        canComeLeftLeft &&
        (!canComeLeft || leftLeftScore >= leftScore) &&
        (!canComeDiag || leftLeftScore >= diagScore)
      ) {
        table[row][column] = leftLeftScore;
        arrows[row][column] = ARROW_LEFT_LEFT;
        diag[row][column] = 0;
      } else if (canComeLeft && (!canComeDiag || leftScore >= diagScore)) {
        table[row][column] = leftScore;
        arrows[row][column] = ARROW_LEFT;
        diag[row][column] = 0;
      } else if (canComeDiag) {
        table[row][column] = diagScore;
        arrows[row][column] = ARROW_DIAG;
        diag[row][column] = diag[row - 1][column - 1] + 1;
      } else {
        return null;
      }
    }
  }

  if (!hasStrongFirstMatch[0]) return null;

  let row = patternLen;
  let column = wordLen;
  let score = table[row][column];

  // The DP picks the earliest match on ties (left arrows win), so the start offset is
  // simply the first diagonal the walk-back lands on.
  let backwardsDiagLength = 0;
  let maxMatchColumn = 0;

  while (row >= 1) {
    let diagColumn = column;
    do {
      const arrow = arrows[row][diagColumn];
      if (arrow === ARROW_LEFT_LEFT) {
        diagColumn -= 2;
      } else if (arrow === ARROW_LEFT) {
        diagColumn -= 1;
      } else {
        break;
      }
    } while (diagColumn >= 1);

    if (
      backwardsDiagLength > 1 &&
      patternLow[row - 1] === wordLow[column - 1] &&
      !isUpperCaseAtPos(diagColumn - 1, word, wordLow) &&
      backwardsDiagLength + 1 > diag[row][diagColumn]
    ) {
      diagColumn = column;
    }

    if (diagColumn === column) {
      backwardsDiagLength += 1;
    } else {
      backwardsDiagLength = 1;
    }

    if (!maxMatchColumn) maxMatchColumn = diagColumn;

    row -= 1;
    column = diagColumn - 1;
  }

  if (wordLen === patternLen) score += 2;
  score -= maxMatchColumn - patternLen;

  return score;
}
