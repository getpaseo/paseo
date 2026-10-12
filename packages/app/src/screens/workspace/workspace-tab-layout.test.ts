import { describe, expect, it } from "vitest";
import {
  computeWorkspaceTabLayout,
  retainWorkspaceTabMeasuredWidth,
} from "@/screens/workspace/workspace-tab-layout";

const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  minTabWidth: 64,
  maxTabWidth: 160,
  tabIconWidth: 14,
  tabContentGap: 4,
  tabHorizontalPadding: 8,
  closeButtonWidth: 0,
};

describe("computeWorkspaceTabLayout", () => {
  it("keeps each tab at its natural content width when space is available", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [56, 70, 49],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("lets short labels use their content width below the old 96px floor", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 300,
      tabLabelWidths: [29, 52],
      metrics: { ...metrics, actionsReservedWidth: 36 },
    });
    expect(result.items).toEqual([
      { width: 64, showLabel: true },
      { width: 86, showLabel: true },
    ]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("sizes a single tab between the minimum and maximum from its content", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [105],
      metrics,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([139]);
  });

  it("shrinks natural widths proportionally without crossing the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([132, 102, 82]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("caps long tabs at the maximum width", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1004,
      tabLabelWidths: [280, 280, 280, 280],
      metrics: {
        ...metrics,
        actionsReservedWidth: 44,
        rowPaddingHorizontal: 0,
        tabGap: 0,
      },
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([160, 160, 160, 160]);
  });

  it("keeps every tab at the clickable minimum at the exact fit boundary", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 404,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("uses horizontal scroll rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 403,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("uses rendered label width rather than character count", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [68, 104],
      metrics,
    });

    expect(result.items.map((item) => item.width)).toEqual([102, 138]);
  });
});

describe("retainWorkspaceTabMeasuredWidth", () => {
  it("retains the last usable width while a retained panel is hidden", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 0)).toBe(720);
  });

  it("accepts the next usable layout width", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 640)).toBe(640);
  });
});

describe("browser tab layout", () => {
  const browserMetrics = { ...metrics, minTabWidth: 120, maxTabWidth: 220, closeButtonWidth: 24 };
  const compute = (viewportWidth: number, tabLabelWidths: number[]) =>
    computeWorkspaceTabLayout({
      variant: "browser",
      viewportWidth,
      tabLabelWidths,
      metrics: browserMetrics,
    });
  it("keeps ten tabs usable at 360px and expands again in a wide row", () => {
    const labels = Array.from({ length: 10 }, (_, index) => index * 100);
    const narrow = compute(360, labels);
    expect(narrow.items).toEqual(labels.map(() => ({ width: 120, showLabel: true })));
    expect(narrow.closeButtonPolicy).toBe("all");
    expect(narrow.requiresHorizontalScrollFallback).toBe(true);
    const wide = compute(2400, labels);
    expect(wide.items.map((item) => item.width)).toEqual(labels.map(() => 220));
    expect(wide.requiresHorizontalScrollFallback).toBe(false);
  });
  it("gives five tabs equal widths independent of long or changing titles", () => {
    const result = compute(1000, [1, 40, 10000, 90, 20]);
    expect(result.items.map((item) => item.width)).toEqual([170, 170, 170, 170, 170]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(compute(1000, [10000, 3, 15, 20, 80])).toEqual(result);
  });
  it("caps a single browser tab while preserving space for favicon and close", () => {
    expect(compute(1000, [10000]).items).toEqual([{ width: 220, showLabel: true }]);
    expect(compute(160, [10000]).items).toEqual([{ width: 120, showLabel: true }]);
  });
});
