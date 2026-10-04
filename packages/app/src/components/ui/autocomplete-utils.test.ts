import { describe, expect, it } from "vitest";

import { getAutocompleteFallbackIndex, orderAutocompleteOptions } from "./autocomplete-utils";

const OPTIONS = ["alpha", "beta", "gamma"];

describe("orderAutocompleteOptions", () => {
  it("keeps first logical option closest to the input by default", () => {
    expect(orderAutocompleteOptions(OPTIONS)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("keeps normal top-down order when below-input is selected", () => {
    expect(orderAutocompleteOptions(OPTIONS, "below-input")).toEqual(["alpha", "beta", "gamma"]);
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
