import { describe, expect, it } from "vitest";

import {
  compareMatchScores,
  fuzzyPolicyForToken,
  matchRanges,
  scoreMatch,
  scoreTextFields,
} from "./text-match.js";

function markUp(query: string, text: string, options?: Parameters<typeof scoreMatch>[2]): string {
  const score = scoreMatch(query, text, options);
  if (!score) return text;
  let marked = "";
  let cursor = 0;
  for (const range of matchRanges(query, text, score)) {
    marked += text.slice(cursor, range.start);
    marked += `[${text.slice(range.start, range.start + range.length)}]`;
    cursor = range.start + range.length;
  }
  return marked + text.slice(cursor);
}

describe("scoreMatch", () => {
  it("returns tier 0 for empty query", () => {
    expect(scoreMatch("", "anything")).toEqual({ tier: 0, offset: 0 });
  });

  it("returns tier 0 for exact match ignoring case", () => {
    expect(scoreMatch("pi", "pi")).toEqual({ tier: 0, offset: 0 });
    expect(scoreMatch("PI", "pi")).toEqual({ tier: 0, offset: 0 });
    expect(scoreMatch("Pi", "pI")).toEqual({ tier: 0, offset: 0 });
  });

  it("returns tier 1 for whole-word match at start", () => {
    expect(scoreMatch("feat", "feat/pi-direct-sdk")).toEqual({ tier: 1, offset: 0 });
  });

  it("returns tier 1 for whole-word match in middle (word boundaries on both sides)", () => {
    expect(scoreMatch("pi", "feat/pi-direct-sdk")).toEqual({ tier: 1, offset: 5 });
    expect(scoreMatch("pi", "a b pi c d")).toEqual({ tier: 1, offset: 4 });
  });

  it("returns tier 2 for string prefix that does not complete a word", () => {
    expect(scoreMatch("par", "party")).toEqual({ tier: 2, offset: 0 });
  });

  it("returns tier 3 for word-boundary start that does not complete a word", () => {
    expect(scoreMatch("par", "a/party")).toEqual({ tier: 3, offset: 2 });
  });

  it("returns tier 4 for substring inside a word", () => {
    expect(scoreMatch("art", "party")).toEqual({ tier: 4, offset: 1 });
  });

  it("returns null when query is not found", () => {
    expect(scoreMatch("xyz", "feat/pi-direct-sdk")).toBeNull();
  });

  it("picks the best tier across multiple occurrences", () => {
    expect(scoreMatch("ab", "xabxab-yy")).toEqual({ tier: 4, offset: 1 });
    expect(scoreMatch("ab", "xxab x-ab-y")).toEqual({ tier: 1, offset: 7 });
  });

  it("prefers earlier offset when tiers are equal", () => {
    expect(scoreMatch("pi", "pi-a pi-b")).toEqual({ tier: 1, offset: 0 });
  });

  it("treats common separators as word boundaries", () => {
    expect(scoreMatch("pi", "x/pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x-pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x_pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x.pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("pi", "x:pi")).toEqual({ tier: 1, offset: 2 });
    expect(scoreMatch("202", "#202 feat")).toEqual({ tier: 1, offset: 1 });
  });

  it("scores PR-title-shaped text realistically", () => {
    const pr202 = "#202 feat(server): replace Pi ACP with direct SDK provider";
    expect(scoreMatch("pi", pr202)?.tier).toBe(1);
    expect(scoreMatch("202", pr202)).toEqual({ tier: 1, offset: 1 });
    expect(scoreMatch("replace", pr202)?.tier).toBe(1);
  });
});

describe("scoreMatch typo tolerance", () => {
  const typoTolerant = { fuzzy: { maxEdits: 2, transpositionsOnly: false } };

  it("is off by default so exact pickers keep exact behavior", () => {
    expect(scoreMatch("bulling", "add stripe billing")).toBeNull();
  });

  it("matches a transposition", () => {
    expect(
      scoreMatch("brnach", "brnach is not branch", {
        fuzzy: { maxEdits: 1, transpositionsOnly: false },
      })?.tier,
    ).toBe(1);
    expect(
      scoreMatch("brnach", "switch the branch", {
        fuzzy: { maxEdits: 1, transpositionsOnly: false },
      })?.tier,
    ).toBe(6);
  });

  it("matches a typo the subsequence tier cannot reach", () => {
    // Dropped characters already land on the subsequence tier; the fuzzy tier
    // exists for the ones that reorder or replace.
    expect(scoreMatch("confg", "revamp configuration editor")?.tier).toBe(5);
    expect(scoreMatch("confug", "revamp configuration editor")).toBeNull();
    expect(scoreMatch("confug", "revamp configuration editor", typoTolerant)?.tier).toBe(6);
  });

  it("reports the offset and edit distance of the word it matched", () => {
    expect(scoreMatch("bulling", "add stripe billing", typoTolerant)).toEqual({
      tier: 6,
      offset: 11,
      spread: 1,
    });
  });

  it("ranks every exact tier ahead of a fuzzy hit", () => {
    const fuzzy = scoreMatch("bilingg", "billing", typoTolerant);
    const worstExact = scoreMatch("iln", "billing");
    if (!fuzzy || !worstExact) throw new Error("expected both scores");
    expect(compareMatchScores(worstExact, fuzzy)).toBeLessThan(0);
  });

  it("refuses to fuzzy-match beyond the budget", () => {
    // "stpie" is two edits from "stripe": insert the r, then swap p and i.
    expect(
      scoreMatch("stpie", "add stripe billing", {
        fuzzy: { maxEdits: 2, transpositionsOnly: false },
      })?.tier,
    ).toBe(6);
    expect(
      scoreMatch("stpie", "add stripe billing", {
        fuzzy: { maxEdits: 1, transpositionsOnly: false },
      }),
    ).toBeNull();
    expect(
      scoreMatch("zzzzzz", "add stripe billing", {
        fuzzy: { maxEdits: 2, transpositionsOnly: false },
      }),
    ).toBeNull();
  });

  it("forgives only transpositions in short tokens, where a substitution matches too much", () => {
    expect(fuzzyPolicyForToken("pi")).toBeNull();
    expect(fuzzyPolicyForToken("main")).toEqual({ maxEdits: 1, transpositionsOnly: true });
    expect(fuzzyPolicyForToken("stipe")).toEqual({ maxEdits: 1, transpositionsOnly: false });
    expect(fuzzyPolicyForToken("configration")).toEqual({ maxEdits: 2, transpositionsOnly: false });

    // The branch typo that has to work.
    expect(scoreMatch("mian", "switch to main", { fuzzy: fuzzyPolicyForToken("mian") })?.tier).toBe(
      6,
    );
    // Words one substitution from "main" stay out.
    for (const nearMiss of ["mial", "rain", "maid"]) {
      expect(
        scoreMatch(nearMiss, "switch to main", { fuzzy: fuzzyPolicyForToken(nearMiss) }),
      ).toBeNull();
    }
  });

  it("finds a transposed short token at the head of a longer word", () => {
    expect(
      scoreMatch("mian", "feat/mainline-fix", { fuzzy: fuzzyPolicyForToken("mian") })?.tier,
    ).toBe(6);
  });
});

describe("scoreTextFields", () => {
  it("requires every token to match some field", () => {
    expect(scoreTextFields("stripe billing", ["add stripe billing system"])).not.toBeNull();
    expect(scoreTextFields("stripe rosetta", ["add stripe billing system"])).toBeNull();
  });

  it("lets tokens match across different fields", () => {
    expect(scoreTextFields("stripe main", ["add stripe billing", "main"])).not.toBeNull();
  });

  it("carries typo tolerance down to each token", () => {
    expect(
      scoreTextFields("stipe bulling", ["add stripe billing"], { typoTolerant: true }),
    ).not.toBeNull();
    expect(scoreTextFields("stipe bulling", ["add stripe billing"])).toBeNull();
  });
});

describe("compareMatchScores", () => {
  it("sorts by tier ascending", () => {
    expect(compareMatchScores({ tier: 1, offset: 10 }, { tier: 2, offset: 0 })).toBeLessThan(0);
    expect(compareMatchScores({ tier: 3, offset: 0 }, { tier: 1, offset: 99 })).toBeGreaterThan(0);
  });

  it("tie-breaks by offset ascending at the same tier", () => {
    expect(compareMatchScores({ tier: 1, offset: 0 }, { tier: 1, offset: 5 })).toBeLessThan(0);
    expect(compareMatchScores({ tier: 1, offset: 5 }, { tier: 1, offset: 5 })).toBe(0);
  });
});

describe("matchRanges", () => {
  it("marks a whole-word hit", () => {
    expect(markUp("stripe", "add stripe billing")).toBe("add [stripe] billing");
  });

  it("marks a hit buried inside a word", () => {
    expect(markUp("bill", "unbilled usage")).toBe("un[bill]ed usage");
  });

  it("marks the exact text when the whole field is the query", () => {
    expect(markUp("main", "main")).toBe("[main]");
  });

  it("marks the scattered characters a subsequence walked", () => {
    expect(markUp("confg", "configuration")).toBe("[conf]i[g]uration");
  });

  it("marks the whole word a typo resolved to", () => {
    // The characters the user got wrong are not in the text to point at, so
    // the word is the smallest honest thing to mark.
    expect(markUp("bulling", "add stripe billing", { fuzzy: fuzzyPolicyForToken("bulling") })).toBe(
      "add stripe [billing]",
    );
  });

  it("marks a transposed short token", () => {
    expect(markUp("mian", "switch to main", { fuzzy: fuzzyPolicyForToken("mian") })).toBe(
      "switch to [main]",
    );
  });

  it("returns nothing for an empty query", () => {
    expect(matchRanges("", "anything", { tier: 0, offset: 0 })).toEqual([]);
  });
});
