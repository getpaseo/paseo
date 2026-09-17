import { expect, it } from "vitest";
import { Reveal } from "./reveal";

it("keeps a word's fade time when its rendered position or surface changes", () => {
  // Five whitespace-delimited words share the 60ms interval: 12ms each.
  const reveal = Reveal.begin("").receive("| same | same |\n", 1000, 60);
  // The two identical words become separate table cells after parsing.
  expect(reveal.surface("same", [2, 3, 4, 5], 1080)).toEqual([
    { start: 0, end: 4, startedAt: 1012, spanMs: 12 },
  ]);
  expect(reveal.surface("same", [9, 10, 11, 12], 1080)).toEqual([
    { start: 0, end: 4, startedAt: 1036, spanMs: 12 },
  ]);
  expect(reveal.surface("same", [2, 3, 4, 5], 1230)).toEqual([]);
});

it("keeps previous paragraphs opaque while a new word arrives", () => {
  let reveal = Reveal.begin("history ").receive("history same ", 1000, 60);
  reveal = reveal.receive("history same same ", 1300, 60);
  expect(reveal.surface("same", [8, 9, 10, 11], 1300)).toEqual([]);
  expect(reveal.surface("same", [13, 14, 15, 16], 1300)).toEqual([
    { start: 0, end: 4, startedAt: 1300, spanMs: 60 },
  ]);
});

it("does not turn hydration or replacement into a fade", () => {
  const reveal = Reveal.begin("history").receive("replacement", 1000, 60);
  expect(
    reveal.surface(
      "replacement",
      Array.from({ length: 11 }, (_, i) => i),
      1000,
    ),
  ).toEqual([]);
});

it("fades text next to synthetic Markdown line breaks", () => {
  const reveal = Reveal.begin("").receive("word  \n", 1000, 60);
  expect(reveal.surface("word\n", [0, 1, 2, 3, -1], 1050)).toEqual([
    { start: 0, end: 4, startedAt: 1000, spanMs: 60 },
  ]);
});

it("continues the front across word boundaries instead of restarting it", () => {
  // Word interval 60ms: "one" owns 1000–1060, "two" owns 1060–1120.
  let reveal = Reveal.begin("").receive("one ", 1000, 60);
  reveal = reveal.receive("one two ", 1060, 60);
  const [one, two] = reveal.surface("one two", [0, 1, 2, 3, 4, 5, 6], 1070);
  expect(one).toEqual({ start: 0, end: 3, startedAt: 1000, spanMs: 60 });
  expect(two).toEqual({ start: 4, end: 7, startedAt: 1060, spanMs: 60 });
  // The last character of "one" starts at 1040; the first of "two" at 1060.
  expect(one!.startedAt + (one!.spanMs * 2) / 3).toBeLessThan(two!.startedAt);
});

it("never lets an early frame start a word before the previous word's run ends", () => {
  let reveal = Reveal.begin("").receive("one ", 1000, 60);
  reveal = reveal.receive("one two ", 1045, 60);
  expect(reveal.ranges.map((range) => range.startedAt)).toEqual([1000, 1060]);
});

it("keeps a run's timeline when inline formatting splits it across surfaces", () => {
  const reveal = Reveal.begin("").receive("ab**cd** ", 1000, 80);
  // The source word is `ab**cd**` (8 chars, 10ms each); the bold piece starts at
  // source offset 4 and is rendered separately from `ab`.
  expect(reveal.surface("ab", [0, 1], 1010)).toEqual([
    { start: 0, end: 2, startedAt: 1000, spanMs: 20 },
  ]);
  expect(reveal.surface("cd", [4, 5], 1010)).toEqual([
    { start: 0, end: 2, startedAt: 1040, spanMs: 20 },
  ]);
});

it("shares one interval between words that arrive together, in order", () => {
  const reveal = Reveal.begin("").receive("one two ", 1000, 60);
  expect(reveal.ranges).toEqual([
    { start: 0, end: 3, startedAt: 1000, spanMs: 30 },
    { start: 4, end: 7, startedAt: 1030, spanMs: 30 },
  ]);
});
