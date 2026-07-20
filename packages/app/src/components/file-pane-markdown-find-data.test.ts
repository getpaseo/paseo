import { describe, expect, it } from "vitest";
import {
  countMarkdownFindMatches,
  createMarkdownFindMatchBases,
  createMarkdownFindModel,
} from "./file-pane-markdown-find-data";

describe("rendered Markdown find match ordinals", () => {
  it("keeps the selected source occurrence aligned with its rendered text leaf", () => {
    const bases = createMarkdownFindMatchBases({
      query: "url",
      runs: [
        { key: "heading", content: "Tool url" },
        { key: "body", content: "url then another url" },
      ],
    });

    expect([...bases]).toEqual([
      ["heading", 0],
      ["body", 1],
    ]);
  });

  it("does not advance the active-match ordinal when the markdown renderer revisits a leaf", () => {
    const bases = createMarkdownFindMatchBases({
      query: "needle",
      runs: [
        { key: "first", content: "needle" },
        { key: "first", content: "needle" },
        { key: "second", content: "needle" },
      ],
    });

    expect([...bases]).toEqual([
      ["first", 0],
      ["second", 1],
    ]);
  });

  it("keeps rendered markdown active-match indexing inert for an empty query", () => {
    expect([
      ...createMarkdownFindMatchBases({ query: "", runs: [{ key: "body", content: "text" }] }),
    ]).toEqual([["body", 0]]);
  });

  it("counts only rendered text occurrences for a text leaf", () => {
    expect(countMarkdownFindMatches("url then url", "url")).toBe(2);
  });

  it("navigates only rendered text runs", () => {
    const selectedMatchIndices: number[] = [];
    const model = createMarkdownFindModel({
      getRuns: () => [
        { key: "text", content: "find token then find token" },
        { key: "text", content: "find token then find token" },
      ],
      onSelectMatch(matchIndex) {
        selectedMatchIndices.push(matchIndex);
      },
    });

    model.adapter.setQuery("find");
    model.adapter.selectNext();

    expect(model.adapter.getState()).toMatchObject({ matchCount: 2, selectedIndex: 1 });
    expect(selectedMatchIndices).toEqual([0, 1]);
  });
});
