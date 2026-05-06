import { describe, expect, it } from "vitest";
import { computeWorkspaceTabLayout } from "@/screens/workspace/workspace-tab-layout";

const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  maxTabWidth: 200,
  tabIconWidth: 14,
  tabHorizontalPadding: 12,
  estimatedCharWidth: 7,
  closeButtonWidth: 22,
};

describe("computeWorkspaceTabLayout", () => {
  it("caps equal-width tabs at the ideal width when there is extra horizontal space", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelLengths: [8, 10, 7],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([200, 200, 200]);
  });

  it("shrinks equal-width tabs proportionally to fit the pane", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 520,
      tabLabelLengths: [24, 12, 8],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([125, 125, 125]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("uses the split width for evenly sized tabs when space is available", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 743,
      tabLabelLengths: [8, 8, 8, 8],
      metrics: {
        ...metrics,
        actionsReservedWidth: 44,
        rowPaddingHorizontal: 0,
        tabGap: 0,
      },
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([175, 175, 175, 175]);
  });

  it("collapses to icon-only before allowing horizontal scroll fallback", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 388,
      tabLabelLengths: [14, 14, 14, 14],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([60, 60, 60, 60]);
    expect(result.items.every((item) => !item.showLabel)).toBe(true);
  });

  it("allows horizontal scroll only when icon-only tabs still cannot fit", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 300,
      tabLabelLengths: [14, 14, 14, 14],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([60, 60, 60, 60]);
    expect(result.items.every((item) => !item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelLengths: [],
      metrics,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });
});
