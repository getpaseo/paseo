import { describe, expect, it } from "vitest";

import {
  advanceTextReveal,
  beginTextReveal,
  clampToSafeRevealBoundary,
  completeTextReveal,
  computeRevealStep,
  nextTextRevealFrame,
  isTextRevealSettled,
  retargetTextReveal,
  TEXT_REVEAL_FRAME_INTERVAL_MS,
  TEXT_REVEAL_HORIZON_MS,
  visibleRevealedText,
  withholdPartialClosingFence,
} from "./text-reveal";

describe("computeRevealStep", () => {
  it("reveals nothing when there is no backlog", () => {
    expect(computeRevealStep({ backlog: 0, elapsedMs: 16 })).toBe(0);
    expect(computeRevealStep({ backlog: -5, elapsedMs: 16 })).toBe(0);
  });

  it("drains the backlog over the horizon", () => {
    const step = computeRevealStep({ backlog: 300, elapsedMs: TEXT_REVEAL_HORIZON_MS / 2 });
    expect(step).toBe(150);
  });

  it("reveals the whole backlog once a frame covers the horizon", () => {
    expect(computeRevealStep({ backlog: 42, elapsedMs: TEXT_REVEAL_HORIZON_MS })).toBe(42);
    expect(computeRevealStep({ backlog: 42, elapsedMs: TEXT_REVEAL_HORIZON_MS * 10 })).toBe(42);
  });

  it("scales the rate with the backlog so a faster model reveals faster", () => {
    const slow = computeRevealStep({ backlog: 20, elapsedMs: 16 });
    const fast = computeRevealStep({ backlog: 200, elapsedMs: 16 });
    expect(fast).toBeGreaterThan(slow);
  });

  it("always advances at least one character so the tail finishes", () => {
    expect(computeRevealStep({ backlog: 1, elapsedMs: 1 })).toBe(1);
    expect(computeRevealStep({ backlog: 2, elapsedMs: 0.01 })).toBe(1);
  });

  it("never overshoots the backlog", () => {
    for (const backlog of [1, 3, 7, 50]) {
      expect(computeRevealStep({ backlog, elapsedMs: 120 })).toBeLessThanOrEqual(backlog);
    }
  });

  it("reveals nothing when no time has passed", () => {
    expect(computeRevealStep({ backlog: 100, elapsedMs: 0 })).toBe(0);
    expect(computeRevealStep({ backlog: 100, elapsedMs: -16 })).toBe(0);
  });

  it("converges within a bounded number of frames at 60Hz", () => {
    let remaining = 500;
    let frames = 0;
    while (remaining > 0) {
      remaining -= computeRevealStep({ backlog: remaining, elapsedMs: 16 });
      frames += 1;
      expect(frames).toBeLessThan(120);
    }
    expect(remaining).toBe(0);
  });

  it("keeps per-frame steps smooth for a bursty arrival pattern", () => {
    // A lumpy arrival sequence: the daemon's coalescing window carries wildly
    // different character counts depending on model throughput.
    const arrivals = [4, 180, 6, 240, 2, 90, 300, 8];
    const steps: number[] = [];
    let backlog = 0;

    for (const arrival of arrivals) {
      backlog += arrival;
      // ~60ms of frames between coalesced flushes.
      for (let frame = 0; frame < 4; frame += 1) {
        const step = computeRevealStep({ backlog, elapsedMs: 16 });
        backlog -= step;
        steps.push(step);
      }
    }

    // Painting arrivals directly would swing from 2 to 300 characters in one
    // paint. Pacing keeps the largest single paint far below the largest arrival.
    expect(Math.max(...steps)).toBeLessThan(Math.max(...arrivals) / 2);
    expect(Math.min(...steps)).toBeGreaterThan(0);
  });
});

describe("clampToSafeRevealBoundary", () => {
  it("leaves boundaries in plain text alone", () => {
    expect(clampToSafeRevealBoundary("hello world", 5)).toBe(5);
  });

  it("clamps the ends", () => {
    expect(clampToSafeRevealBoundary("hello", -3)).toBe(0);
    expect(clampToSafeRevealBoundary("hello", 99)).toBe(5);
  });

  it("never splits a surrogate pair", () => {
    // "a😀b" — the emoji occupies indices 1 and 2.
    const text = "a😀b";
    expect(clampToSafeRevealBoundary(text, 2)).toBe(1);
    expect(clampToSafeRevealBoundary(text, 3)).toBe(3);
  });

  it("does not strand a combining mark", () => {
    // "e" + combining acute; cutting at 1 would show a bare "e" then reflow.
    const text = `éx`;
    expect(clampToSafeRevealBoundary(text, 1)).toBe(0);
    expect(clampToSafeRevealBoundary(text, 2)).toBe(2);
  });

  it("does not split an emoji ZWJ sequence", () => {
    // Family emoji: person ZWJ person ZWJ child.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const text = `${family}!`;
    for (let index = 1; index < family.length; index += 1) {
      expect(clampToSafeRevealBoundary(text, index)).toBe(0);
    }
    expect(clampToSafeRevealBoundary(text, family.length)).toBe(family.length);
  });

  it("does not split a skin tone modifier from its base", () => {
    const text = "\u{1F44D}\u{1F3FD} nice";
    expect(clampToSafeRevealBoundary(text, 2)).toBe(0);
    expect(clampToSafeRevealBoundary(text, 4)).toBe(4);
  });

  it("does not strand a variation selector", () => {
    const text = "❤️ done";
    expect(clampToSafeRevealBoundary(text, 1)).toBe(0);
    expect(clampToSafeRevealBoundary(text, 2)).toBe(2);
  });

  it("does not split extended grapheme clusters", () => {
    for (const { text, boundaries } of [
      { text: "a🇺🇸b", boundaries: [0, 1, 5, 6] },
      { text: "a가b", boundaries: [0, 1, 3, 4] },
      { text: "aकःb", boundaries: [0, 1, 3, 4] },
    ]) {
      for (let index = 1; index < text.length; index += 1) {
        const expected = boundaries.toReversed().find((boundary) => boundary <= index);
        expect(clampToSafeRevealBoundary(text, index)).toBe(expected);
      }
    }
  });
});

describe("nextTextRevealFrame", () => {
  it("caps a high-refresh frame clock at 60Hz", () => {
    expect(nextTextRevealFrame(null, 0)).toEqual({
      elapsedMs: TEXT_REVEAL_FRAME_INTERVAL_MS,
      frameAtMs: 0,
    });
    expect(nextTextRevealFrame(0, 8)).toBeNull();
    expect(nextTextRevealFrame(0, 17)).toEqual({
      elapsedMs: 17,
      frameAtMs: expect.closeTo(TEXT_REVEAL_FRAME_INTERVAL_MS, 5),
    });
  });
});

describe("text reveal state", () => {
  it("reveals the first text it sees in full", () => {
    const state = beginTextReveal("already here");
    expect(visibleRevealedText(state)).toBe("already here");
    expect(isTextRevealSettled(state)).toBe(true);
  });

  it("paces growth instead of painting it whole", () => {
    let state = beginTextReveal("a");
    state = retargetTextReveal(state, `a${"b".repeat(300)}`);
    expect(visibleRevealedText(state)).toBe("a");

    state = advanceTextReveal(state, 16);
    const shown = visibleRevealedText(state);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(301);
  });

  it("catches up to the full text across frames", () => {
    const full = `a${"b".repeat(200)}`;
    let state = retargetTextReveal(beginTextReveal("a"), full);
    for (let frame = 0; frame < 60 && !isTextRevealSettled(state); frame += 1) {
      state = advanceTextReveal(state, 16);
    }
    expect(isTextRevealSettled(state)).toBe(true);
    expect(visibleRevealedText(state)).toBe(full);
  });

  it("releases everything when the turn completes", () => {
    const full = `a${"b".repeat(500)}`;
    let state = advanceTextReveal(retargetTextReveal(beginTextReveal("a"), full), 16);
    expect(visibleRevealedText(state)).not.toBe(full);

    state = completeTextReveal(state);
    expect(visibleRevealedText(state)).toBe(full);
  });

  it("only ever paints a prefix of the real text", () => {
    const full = "the quick brown fox jumps over the lazy dog";
    let state = retargetTextReveal(beginTextReveal("the "), full);
    for (let frame = 0; frame < 20; frame += 1) {
      expect(full.startsWith(visibleRevealedText(state))).toBe(true);
      state = advanceTextReveal(state, 16);
    }
  });

  it("clamps when the slot switches to a shorter message", () => {
    const state = retargetTextReveal(beginTextReveal("a long streaming message"), "short");
    expect(visibleRevealedText(state)).toBe("short");
  });

  it("never paints a lone surrogate while streaming emoji", () => {
    const full = `progress ${"\u{1F680}".repeat(40)} done`;
    let state = retargetTextReveal(beginTextReveal("progress "), full);
    for (let frame = 0; frame < 200 && !isTextRevealSettled(state); frame += 1) {
      const shown = visibleRevealedText(state);
      // A stranded surrogate would make the painted prefix un-decodable.
      expect(shown).toBe(Array.from(shown).join(""));
      expect(full.startsWith(shown)).toBe(true);
      state = advanceTextReveal(state, 16);
    }
    expect(visibleRevealedText(completeTextReveal(state))).toBe(full);
  });

  it("a long cluster cannot stall the reveal", () => {
    // The rendered boundary backs up over this cluster, but the counter does not,
    // so the reveal still finishes.
    const full = `x${"́".repeat(40)}y`;
    let state = retargetTextReveal(beginTextReveal("x"), full);
    for (let frame = 0; frame < 200 && !isTextRevealSettled(state); frame += 1) {
      state = advanceTextReveal(state, 16);
    }
    expect(isTextRevealSettled(state)).toBe(true);
    expect(visibleRevealedText(state)).toBe(full);
  });
});

describe("trailing fragments from arrival boundaries", () => {
  it("holds back half a flag while more text is coming", () => {
    // The daemon's coalescing window can end a delta mid-cluster, so a caught-up
    // reveal can be handed a single regional indicator.
    const halfFlag = "flags: \u{1F1EC}";
    const state = beginTextReveal(halfFlag);
    expect(visibleRevealedText(state, { streaming: true })).toBe("flags: ");
    // Once the turn ends nothing more is coming, so paint what there is.
    expect(visibleRevealedText(state, { streaming: false })).toBe(halfFlag);
  });

  it("paints the flag once its second half arrives", () => {
    const whole = "flags: \u{1F1EC}\u{1F1E7}";
    expect(visibleRevealedText(beginTextReveal(whole), { streaming: true })).toBe(whole);
  });

  it("keeps an even run of regional indicators intact", () => {
    const twoFlags = "\u{1F1EC}\u{1F1E7}\u{1F1EB}\u{1F1F7}";
    expect(visibleRevealedText(beginTextReveal(twoFlags), { streaming: true })).toBe(twoFlags);
  });

  it("holds back a dangling joiner", () => {
    expect(
      visibleRevealedText(beginTextReveal("family: \u{1F468}\u200D"), { streaming: true }),
    ).toBe("family: \u{1F468}");
  });

  it("holds back a dangling high surrogate", () => {
    const loneHigh = `broken: ${String.fromCharCode(0xd83d)}`;
    expect(visibleRevealedText(beginTextReveal(loneHigh), { streaming: true })).toBe("broken: ");
  });

  it("leaves ordinary trailing text alone", () => {
    const prose = "just some prose";
    expect(visibleRevealedText(beginTextReveal(prose), { streaming: true })).toBe(prose);
  });
});

describe("a closing fence still being typed", () => {
  const code = "Intro\n\n```ts\nconst a = 1;\n";

  it("holds back one or two backticks that can only become the closing fence", () => {
    expect(withholdPartialClosingFence(`${code}\``)).toBe(code);
    expect(withholdPartialClosingFence(`${code}\`\``)).toBe(code);
    expect(withholdPartialClosingFence(`${code}  \`\``)).toBe(code);
  });

  it.each([
    { char: "`", length: 3, whitespace: " " },
    { char: "`", length: 3, whitespace: "\t" },
    { char: "`", length: 4, whitespace: " " },
    { char: "`", length: 4, whitespace: "\t" },
    { char: "~", length: 3, whitespace: " " },
    { char: "~", length: 3, whitespace: "\t" },
    { char: "~", length: 5, whitespace: " " },
    { char: "~", length: 5, whitespace: "\t" },
  ])(
    "paints real code after whitespace ends a $length $char run ($whitespace)",
    ({ char, length, whitespace }) => {
      const prefix = `${char.repeat(length)}\ncode\n`;
      const run = char.repeat(length - 1);
      expect(withholdPartialClosingFence(prefix + run)).toBe(prefix);
      const text = prefix + run + whitespace;
      expect(withholdPartialClosingFence(text)).toBe(text);
      expect(visibleRevealedText(beginTextReveal(text), { streaming: true })).toBe(text);
    },
  );

  it("paints the fence once it closes the block", () => {
    expect(withholdPartialClosingFence(`${code}\`\`\``)).toBe(`${code}\`\`\``);
    expect(withholdPartialClosingFence(`${code}\`\`\`\n\nAfter`)).toBe(`${code}\`\`\`\n\nAfter`);
  });

  it("needs a run as long as the opener and of the same character", () => {
    const long = "````md\nInside\n";
    expect(withholdPartialClosingFence(`${long}\`\`\``)).toBe(long);
    expect(withholdPartialClosingFence(`${long}\`\`\`\``)).toBe(`${long}\`\`\`\``);
    const tilde = "~~~\ncode\n";
    expect(withholdPartialClosingFence(`${tilde}~~`)).toBe(tilde);
    expect(withholdPartialClosingFence(`${tilde}\``)).toBe(`${tilde}\``);
  });

  it.each([
    { lineEnding: "LF", newline: "\n", closer: "```" },
    { lineEnding: "CRLF", newline: "\r\n", closer: "```" },
    { lineEnding: "LF", newline: "\n", closer: "``` \t" },
    { lineEnding: "CRLF", newline: "\r\n", closer: "``` \t" },
  ])(
    "recognizes completed closers before a tilde block with $lineEnding ($closer)",
    ({ newline, closer }) => {
      const backtickBlock = ["Intro", "```ts", "const a = 1;", closer, ""].join(newline);
      const tildeBlock = backtickBlock + ["~~~md", "code", ""].join(newline);

      expect(withholdPartialClosingFence(tildeBlock + "~~")).toBe(tildeBlock);
      expect(withholdPartialClosingFence(tildeBlock + "~~~")).toBe(tildeBlock + "~~~");
      expect(withholdPartialClosingFence(tildeBlock + "~~ not a closer")).toBe(
        tildeBlock + "~~ not a closer",
      );

      const closedTildeBlock = tildeBlock + "~~~" + newline;
      expect(withholdPartialClosingFence(closedTildeBlock + "`")).toBe(closedTildeBlock + "`");
    },
  );

  it.each([
    { marker: "-", fence: "```", newline: "\n" },
    { marker: "1.", fence: "~~~", newline: "\n" },
    { marker: "-", fence: "~~~", newline: "\r\n" },
    { marker: "1.", fence: "```", newline: "\r\n" },
  ])(
    "keeps prose after a closed $marker list fence ($fence, $newline)",
    ({ marker, fence, newline }) => {
      const indent = " ".repeat(marker.length + 1);
      const closed = [`${marker} ${fence}`, `${indent}code`, `${indent}${fence}`, "", ""].join(
        newline,
      );
      const prose = closed + fence[0];
      expect(withholdPartialClosingFence(prose)).toBe(prose);
      expect(visibleRevealedText(beginTextReveal(prose), { streaming: true })).toBe(prose);
      const open = [`${marker} ${fence}`, `${indent}code`, ""].join(newline);
      expect(withholdPartialClosingFence(open + indent + fence[0])).toBe(open);
    },
  );

  it("does not take an indented code block's fence for a top-level opener", () => {
    const text = "    code\n    ```\n\n`";
    expect(withholdPartialClosingFence(text)).toBe(text);
  });

  it("leaves backticks alone outside a code block", () => {
    expect(withholdPartialClosingFence("Prose\n`")).toBe("Prose\n`");
    const closed = "```\na\n```\n";
    expect(withholdPartialClosingFence(`${closed}\``)).toBe(`${closed}\``);
    expect(withholdPartialClosingFence("`` inline ``\n`")).toBe("`` inline ``\n`");
  });

  it("leaves a code line that only starts with backticks alone", () => {
    expect(withholdPartialClosingFence(`${code}\`x`)).toBe(`${code}\`x`);
  });

  it("never paints a lone backtick line while a paced reveal crosses the closing fence", () => {
    const full = `${code}\`\`\`\n\nAfter the block.`;
    let state = retargetTextReveal(beginTextReveal(code), full);
    const painted: string[] = [];
    for (let frame = 0; frame < 120 && !isTextRevealSettled(state); frame += 1) {
      state = advanceTextReveal(state, 16, 1_000);
      painted.push(visibleRevealedText(state, { streaming: true }));
    }
    expect(painted.at(-1)).toBe(full);
    for (const text of painted) {
      expect(full.startsWith(text)).toBe(true);
      expect(text.endsWith("\n`") || text.endsWith("\n``")).toBe(false);
    }
  });

  it("holds the fence back when an arrival ends inside it, and paints it once the turn ends", () => {
    const state = beginTextReveal(`${code}\``);
    expect(visibleRevealedText(state, { streaming: true })).toBe(code);
    expect(visibleRevealedText(state, { streaming: false })).toBe(`${code}\``);
  });
});
