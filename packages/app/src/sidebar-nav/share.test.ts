import { describe, expect, it } from "vitest";
import {
  clampSidebarNavShare,
  DEFAULT_SIDEBAR_NAV_SHARE,
  MAX_SIDEBAR_NAV_SHARE,
  MIN_SIDEBAR_NAV_SHARE,
  parseSidebarNavShare,
} from "./share";

describe("sidebar nav share", () => {
  it("defaults to the 50% cap the nav block always had", () => {
    expect(DEFAULT_SIDEBAR_NAV_SHARE).toBe(0.5);
    expect(DEFAULT_SIDEBAR_NAV_SHARE).toBe(MAX_SIDEBAR_NAV_SHARE);
  });

  it("clamps into the allowed range", () => {
    expect(clampSidebarNavShare(0.3)).toBe(0.3);
    expect(clampSidebarNavShare(0)).toBe(MIN_SIDEBAR_NAV_SHARE);
    expect(clampSidebarNavShare(0.9)).toBe(MAX_SIDEBAR_NAV_SHARE);
  });

  it("falls back to the default for stored values that are not finite numbers", () => {
    for (const value of ["0.2", null, undefined, NaN, Infinity, {}, []]) {
      expect(parseSidebarNavShare(value)).toBe(DEFAULT_SIDEBAR_NAV_SHARE);
    }
  });

  it("clamps stored numbers instead of discarding them", () => {
    expect(parseSidebarNavShare(0.25)).toBe(0.25);
    expect(parseSidebarNavShare(-3)).toBe(MIN_SIDEBAR_NAV_SHARE);
    expect(parseSidebarNavShare(7)).toBe(MAX_SIDEBAR_NAV_SHARE);
  });
});
