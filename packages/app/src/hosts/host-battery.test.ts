import { describe, expect, it } from "vitest";

import { formatHostBatteryPercent } from "./host-battery";

/**
 * Assertions compare formatted output against other formatted output rather than against
 * literal strings like "37%". The formatter is deliberately locale-aware, so a literal would
 * encode whichever locale the test runner happened to boot with — French renders `37 %` and
 * Arabic uses its own numerals. What these tests own is the rounding and clamping.
 */
describe("formatHostBatteryPercent", () => {
  it("renders a charge", () => {
    const rendered = formatHostBatteryPercent(37);
    expect(rendered).not.toBe("");
    expect(rendered).toBe(
      new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(0.37),
    );
  });

  it("rounds fractional readings to the nearest percent", () => {
    expect(formatHostBatteryPercent(36.6)).toBe(formatHostBatteryPercent(37));
    expect(formatHostBatteryPercent(36.4)).toBe(formatHostBatteryPercent(36));
    expect(formatHostBatteryPercent(36.6)).not.toBe(formatHostBatteryPercent(36));
  });

  it("clamps out-of-range readings the protocol deliberately allows through", () => {
    expect(formatHostBatteryPercent(120)).toBe(formatHostBatteryPercent(100));
    expect(formatHostBatteryPercent(-5)).toBe(formatHostBatteryPercent(0));
  });

  it("renders the extremes rather than treating them as missing", () => {
    expect(formatHostBatteryPercent(0)).not.toBe("");
    expect(formatHostBatteryPercent(100)).not.toBe("");
    expect(formatHostBatteryPercent(0)).not.toBe(formatHostBatteryPercent(100));
  });

  it("yields nothing for a non-finite reading so the badge omits it", () => {
    expect(formatHostBatteryPercent(Number.NaN)).toBe("");
    expect(formatHostBatteryPercent(Number.POSITIVE_INFINITY)).toBe("");
  });
});
