import { describe, expect, it } from "vitest";
import { shouldAutofocusModelSearch } from "./combined-model-selector.utils";

describe("shouldAutofocusModelSearch", () => {
  it("keeps desktop web autofocus but avoids compact web keyboard expansion", () => {
    expect(shouldAutofocusModelSearch({ isWeb: true, isCompact: false })).toBe(true);
    expect(shouldAutofocusModelSearch({ isWeb: true, isCompact: true })).toBe(false);
  });

  it("does not autofocus native sheets", () => {
    expect(shouldAutofocusModelSearch({ isWeb: false, isCompact: false })).toBe(false);
    expect(shouldAutofocusModelSearch({ isWeb: false, isCompact: true })).toBe(false);
  });
});
