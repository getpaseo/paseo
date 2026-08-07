import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  isChecksHiddenByLegacyRowItem,
  parseSidebarRowItems,
  SIDEBAR_ROW_ITEMS,
} from "./row-items";

describe("parseSidebarRowItems", () => {
  it("shows everything by default", () => {
    for (const item of SIDEBAR_ROW_ITEMS) {
      expect(DEFAULT_SIDEBAR_ROW_ITEMS[item]).toBe(true);
    }
  });

  it("applies stored overrides", () => {
    expect(parseSidebarRowItems({ services: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      services: false,
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
      parseSidebarRowItems({ checks: false, nonsense: false, services: null, host: false }),
    ).toEqual({ ...DEFAULT_SIDEBAR_ROW_ITEMS, host: false });
  });

  it.each([[null], [undefined], ["diff"], [42], [["services"]]])(
    "falls back to defaults for %s",
    (value) => {
      expect(parseSidebarRowItems(value)).toEqual(DEFAULT_SIDEBAR_ROW_ITEMS);
    },
  );

  it("carries a switched-off scripts item over to services", () => {
    // COMPAT(sidebarRowItemsScripts): the item narrowed from scripts to services in v0.3.0.
    expect(parseSidebarRowItems({ scripts: false })).toEqual({
      ...DEFAULT_SIDEBAR_ROW_ITEMS,
      services: false,
    });
  });

  it("lets a stored services value win over the scripts item it replaced", () => {
    expect(parseSidebarRowItems({ scripts: false, services: true })).toEqual(
      DEFAULT_SIDEBAR_ROW_ITEMS,
    );
  });

  it("does not hand back the shared default object", () => {
    const parsed = parseSidebarRowItems({ services: false });
    expect(parsed).not.toBe(DEFAULT_SIDEBAR_ROW_ITEMS);
    expect(DEFAULT_SIDEBAR_ROW_ITEMS.services).toBe(true);
  });
});

describe("isChecksHiddenByLegacyRowItem", () => {
  it("reports the one stored shape that means checks were switched off", () => {
    expect(isChecksHiddenByLegacyRowItem({ checks: false })).toBe(true);
  });

  it.each([[{ checks: true }], [{ services: false }], [{}], [null], ["checks"], [["checks"]]])(
    "leaves %s to the new setting's default",
    (value) => {
      expect(isChecksHiddenByLegacyRowItem(value)).toBe(false);
    },
  );
});
