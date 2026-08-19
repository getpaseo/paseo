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
  minTabWidth: 96,
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
    expect(result.items.map((item) => item.width)).toEqual([96, 104, 96]);
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
    expect(result.items.map((item) => item.width)).toEqual([117, 103, 96]);
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
      viewportWidth: 532,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([96, 96, 96, 96]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("uses horizontal scroll rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 531,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([96, 96, 96, 96]);
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
