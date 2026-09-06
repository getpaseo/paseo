import { describe, expect, it } from "vitest";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";
import { moveModelHighlight, resolveModelSubmitRow } from "./model-browser-keyboard";

const rows = [
  { provider: "a", modelId: "one", favoriteKey: "a:one" },
  { provider: "a", modelId: "two", favoriteKey: "a:two" },
] as ProviderSelectionModelRow[];

describe("model browser keyboard navigation", () => {
  it("starts at the directional edge and wraps", () => {
    expect(moveModelHighlight({ rows, highlightedKey: null, direction: "next" })).toBe("a:one");
    expect(moveModelHighlight({ rows, highlightedKey: null, direction: "previous" })).toBe("a:two");
    expect(moveModelHighlight({ rows, highlightedKey: "a:two", direction: "next" })).toBe("a:one");
    expect(moveModelHighlight({ rows, highlightedKey: "a:one", direction: "previous" })).toBe(
      "a:two",
    );
  });

  it("submits the highlight or first row", () => {
    expect(resolveModelSubmitRow(rows, "a:two")?.modelId).toBe("two");
    expect(resolveModelSubmitRow(rows, null)?.modelId).toBe("one");
    expect(resolveModelSubmitRow([], null)).toBeNull();
  });
});
