import { describe, expect, it } from "vitest";
import type { StyleProp, ViewStyle } from "react-native";
import { resolveHighlightCorners } from "./press-highlight.shape";

describe("resolveHighlightCorners", () => {
  it("takes the radius from the pressable's own style, the way a sidebar row declares it", () => {
    const row = { minHeight: 36, borderRadius: 8, backgroundColor: "#111" };
    expect(resolveHighlightCorners(row)).toEqual({ borderRadius: 8 });
  });

  it("reads through the style array a row builds per interaction state", () => {
    const row: StyleProp<ViewStyle> = [{ borderRadius: 8 }, false, { backgroundColor: "#222" }];
    expect(resolveHighlightCorners(row)).toEqual({ borderRadius: 8 });
  });

  it("keeps the last radius when a later entry in the array reshapes the row", () => {
    expect(resolveHighlightCorners([{ borderRadius: 8 }, { borderRadius: 999 }])).toEqual({
      borderRadius: 999,
    });
  });

  it("carries every corner a row sets individually", () => {
    const row = { borderTopLeftRadius: 8, borderBottomRightRadius: 2, paddingLeft: 12 };
    expect(resolveHighlightCorners(row)).toEqual({
      borderTopLeftRadius: 8,
      borderBottomRightRadius: 2,
    });
  });

  it("returns no corners for a square row, rather than a zero it never asked for", () => {
    expect(resolveHighlightCorners({ backgroundColor: "#111" })).toEqual({});
    expect(resolveHighlightCorners(undefined)).toEqual({});
  });

  it("leaves a style resolved per press state alone", () => {
    expect(resolveHighlightCorners(() => ({ borderRadius: 8 }))).toEqual({});
  });
});
