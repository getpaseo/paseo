import { describe, expect, it } from "vitest";

import {
  getAutocompleteFallbackIndex,
  getAutocompleteScrollOffset,
  orderAutocompleteOptions,
} from "./autocomplete-utils";

const OPTIONS = ["alpha", "beta", "gamma"];

describe("orderAutocompleteOptions", () => {
  it("keeps first logical option closest to the input by default", () => {
    expect(orderAutocompleteOptions(OPTIONS)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("keeps normal top-down order when below-input is selected", () => {
    expect(orderAutocompleteOptions(OPTIONS, "below-input")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("getAutocompleteFallbackIndex", () => {
  it("picks the option nearest the input by default", () => {
    expect(getAutocompleteFallbackIndex(3)).toBe(2);
    expect(getAutocompleteFallbackIndex(0)).toBe(-1);
  });

  it("picks top item when below-input ordering is used", () => {
    expect(getAutocompleteFallbackIndex(3, "below-input")).toBe(0);
  });
});

describe("getAutocompleteScrollOffset", () => {
  it("scrolls up when the active item is above the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 120,
        viewportHeight: 80,
        itemTop: 90,
        itemHeight: 20,
      })
    ).toBe(90);
  });

  it("scrolls down when the active item is below the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 0,
        viewportHeight: 100,
        itemTop: 150,
        itemHeight: 24,
      })
    ).toBe(74);
  });
});
