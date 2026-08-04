import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_ROW_ITEMS, parseSidebarRowItems, SIDEBAR_ROW_ITEMS } from "./row-items";

describe("parseSidebarRowItems", () => {
  it("shows everything by default", () => {
    for (const item of SIDEBAR_ROW_ITEMS) {
      expect(DEFAULT_SIDEBAR_ROW_ITEMS[item]).toBe(true);
    }
  });

  it("applies stored overrides", () => {
    expect(parseSidebarRowItems({ checks: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      checks: false,
    });
  });

  it("leaves items absent from storage at their default", () => {
    // A newly added item must ship visible rather than inheriting "missing means off".
    expect(parseSidebarRowItems({ host: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      host: false,
    });
  });

  it("ignores unknown keys and non-boolean values", () => {
    expect(
      parseSidebarRowItems({ checks: "yes", nonsense: false, scripts: null, host: false }),
    ).toEqual({ ...DEFAULT_SIDEBAR_ROW_ITEMS, host: false });
  });

  it.each([[null], [undefined], ["diff"], [42], [["checks"]]])(
    "falls back to defaults for %s",
    (value) => {
      expect(parseSidebarRowItems(value)).toEqual(DEFAULT_SIDEBAR_ROW_ITEMS);
    },
  );

  it("does not hand back the shared default object", () => {
    const parsed = parseSidebarRowItems({ checks: false });
    expect(parsed).not.toBe(DEFAULT_SIDEBAR_ROW_ITEMS);
    expect(DEFAULT_SIDEBAR_ROW_ITEMS.checks).toBe(true);
  });
});
