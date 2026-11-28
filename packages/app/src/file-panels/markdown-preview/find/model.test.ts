import { expect, it } from "vitest";
import { MarkdownFindModel, type MarkdownFindView } from "./model";

/** A document of words; each match is the index of a word containing the query. */
function document(words: string[]) {
  const shown: Array<{ current: number; reveal: boolean } | "cleared"> = [];
  const view: MarkdownFindView<number> = {
    search: (query) =>
      query ? words.flatMap((word, index) => (word.includes(query) ? [index] : [])) : [],
    show: (_matches, current, reveal) => shown.push({ current, reveal }),
    clear: () => shown.push("cleared"),
  };
  return { words, shown, model: new MarkdownFindModel(view) };
}

it("searches only while open and lands on the first match", () => {
  const { model, shown } = document(["alpha", "beta", "alphabet"]);
  model.setQuery("alpha");
  expect(model.getSnapshot()).toEqual({ open: false, query: "alpha", current: -1, total: 0 });
  expect(shown).toEqual([]);
  model.open();
  expect(model.getSnapshot()).toEqual({ open: true, query: "alpha", current: 0, total: 2 });
  expect(shown).toEqual([{ current: 0, reveal: true }]);
});

it("wraps next and previous around the matches", () => {
  const { model } = document(["a1", "a2", "b", "a3"]);
  model.open();
  model.setQuery("a");
  model.next();
  model.next();
  expect(model.getSnapshot().current).toBe(2);
  model.next();
  expect(model.getSnapshot().current).toBe(0);
  model.previous();
  expect(model.getSnapshot().current).toBe(2);
});

it("clears the highlight when nothing matches and when closed", () => {
  const { model, shown } = document(["alpha"]);
  model.open();
  model.setQuery("zzz");
  expect(model.getSnapshot()).toMatchObject({ current: -1, total: 0 });
  model.next();
  expect(model.getSnapshot().current).toBe(-1);
  model.setQuery("alpha");
  model.close();
  expect(model.getSnapshot()).toEqual({ open: false, query: "alpha", current: -1, total: 0 });
  expect(shown).toEqual(["cleared", "cleared", { current: 0, reveal: true }, "cleared"]);
});

it("keeps its place without scrolling when the document re-renders", () => {
  const { model, words, shown } = document(["a1", "a2", "a3"]);
  model.open();
  model.setQuery("a");
  model.next();
  model.next();
  words.splice(1, 1);
  model.refresh();
  expect(model.getSnapshot()).toMatchObject({ current: 1, total: 2 });
  expect(shown.at(-1)).toEqual({ current: 1, reveal: false });
});
