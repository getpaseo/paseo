import { buildDesktopFrameStyle } from "@/components/ui/combobox-frame-style";
import {
  WorkspaceHeaderExplorerToggle,
  WorkspaceExplorerSidebarToggle,
} from "./workspace-explorer-toggle";
import { describe, expect, it } from "vitest";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import { resolveWorkspaceTabChipBackdrop } from "@/screens/workspace/workspace-tab-chip-backdrop";
import { darkPureBlackTheme, darkTheme, lightTheme } from "@/styles/theme";
import type { WindowLayout } from "@/window-layout/model";
import {
  workspaceTabSwitcherPopoverLayout,
  selectWorkspaceChrome,
  computeWorkspaceTabLayout,
  retainWorkspaceTabMeasuredWidth,
  resolveInlineWorkspaceTabBudget,
  resolveInlineWorkspaceTitleWidth,
  resolveInlineWorkspaceTabPresentation,
  shouldUseInlineWorkspaceHeader,
  workspaceTabNaturalWidth,
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
      compact: false,
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
      compact: false,
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
      compact: false,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([139]);
  });

  it("shrinks natural widths proportionally without crossing the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
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
      compact: false,
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
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("scrolls at natural widths rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 403,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([132, 132, 132, 132]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps natural widths and no inline close on compact layouts while the tabs fit", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 600,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: true,
    });

    expect(result.closeButtonPolicy).toBe("none");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("scrolls compact layouts as soon as natural widths overflow instead of squeezing labels", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: true,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [],
      metrics,
      compact: false,
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
      compact: false,
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

describe("Explorer toggle ownership", () => {
  const toggleProps = {
    onPress: () => {},
    label: "Close Explorer sidebar",
    tooltipLabel: "Toggle Explorer sidebar",
    tooltipKeys: [],
    accessibilityState: { expanded: true },
  };

  it("keeps only the header toggle when window controls do not obstruct it", () => {
    expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner: "header" })).not.toBeNull();
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "header" })).toBeNull();
  });

  it("keeps the dock toggle for window-owned and compact overlay chrome", () => {
    for (const owner of ["window", "mobile"] as const) {
      expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner })).toBeNull();
      expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner })).not.toBeNull();
    }
  });

  it("closes the compact overlay with the same X as the compact agent list", () => {
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "mobile" })?.type).toBe(
      SidebarCloseButton,
    );
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "window" })?.type).not.toBe(
      SidebarCloseButton,
    );
  });
});

describe("resolveWorkspaceTabChipBackdrop", () => {
  const themes = { light: lightTheme, dark: darkTheme, pureBlack: darkPureBlackTheme };
  const rails = {
    sidebar: "surfaceSidebar",
    surface: "surface0",
  } as const;

  it("paints the active chip in a colour the rail does not already use, in every theme", () => {
    for (const [, theme] of Object.entries(themes)) {
      for (const [rail, resting] of Object.entries(rails) as Array<
        [keyof typeof rails, (typeof rails)[keyof typeof rails]]
      >) {
        const active = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: true,
          isFilled: true,
        });
        const filled = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: false,
          isFilled: true,
        });
        expect(theme.colors[active]).not.toBe(theme.colors[resting]);
        expect(theme.colors[filled]).not.toBe(theme.colors[resting]);
        expect(theme.colors[active]).not.toBe(theme.colors[filled]);
      }
    }
  });

  it("rests on the rail surface when the chip is neither active nor hovered", () => {
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "sidebar", isActiveFocused: false, isFilled: false }),
    ).toBe("surfaceSidebar");
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "surface", isActiveFocused: false, isFilled: false }),
    ).toBe("surface0");
  });
});

it("uses the old single-row header only for eligible landscape workspaces", () => {
  const landscape: WindowLayout = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    verticalBarEdge: "trailing",
    verticalBar: { x: 895, y: 56, width: 56, height: 613 },
    divisions: [],
  };
  const portrait: WindowLayout = {
    ...landscape,
    bounds: { x: 0, y: 0, width: 669, height: 951 },
  };

  expect(shouldUseInlineWorkspaceHeader(portrait)).toBe(false);
  expect(shouldUseInlineWorkspaceHeader(landscape)).toBe(true);
  expect(shouldUseInlineWorkspaceHeader(landscape, true)).toBe(false);
  expect(shouldUseInlineWorkspaceHeader(landscape, false, true)).toBe(false);
  expect(shouldUseInlineWorkspaceHeader({ ...landscape, verticalBar: null })).toBe(false);
});

import { shouldUseCompactWorkspaceHeader } from "./workspace-tab-layout";
it.each([
  [349, true],
  [499, true],
  [500, false],
  [519, false],
  [550, false],
  [800, false],
])("workspace width %s selects compact=%s", (width, compact) => {
  expect(shouldUseCompactWorkspaceHeader(width)).toBe(compact);
});

describe("desktop pane chrome", () => {
  it("replaces the pane header and rail together at the pane width boundary", () => {
    const full = ["workspace header", "pane tab rail"];
    expect(selectWorkspaceChrome({ width: 440, compact: "pane dropdown", full })).toBe(
      "pane dropdown",
    );
    expect(selectWorkspaceChrome({ width: 499, compact: "pane dropdown", full })).toBe(
      "pane dropdown",
    );
    expect(selectWorkspaceChrome({ width: 500, compact: "pane dropdown", full })).toBe(full);
    expect(selectWorkspaceChrome({ width: null, compact: "pane dropdown", full })).toBe(full);
  });
});

describe("inline workspace rail transitions", () => {
  it("keeps a naturally fitting few-tab track below the scrolling viewport floor", () => {
    expect(resolveInlineWorkspaceTabPresentation(220, 220)).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(219, 220)).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(320, 600, "switcher")).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(319, 600)).toBe("switcher");
  });

  it("retains the presentation while a reparented track has no new measurement", () => {
    expect(resolveInlineWorkspaceTabPresentation(200, null, "tabs")).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(200, null, "switcher")).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(320, null, "switcher")).toBe("tabs");
  });

  it("reserves the measured title and lets the rail absorb the rest", () => {
    const budget = (width: number, titleWidth = 196) =>
      resolveInlineWorkspaceTabBudget({
        width,
        horizontalInset: 24,
        navigationWidth: 44,
        navigationGap: 8,
        titleWidth,
        gap: 16,
      });
    expect(budget(600)).toEqual({ titleWidth: 192, railWidth: 316 });
    expect(budget(450)).toEqual({ titleWidth: 142, railWidth: 216 });
    expect(budget(600, 100)).toEqual({ titleWidth: 100, railWidth: 408 });
  });

  it("caps long titles and switches at the projected Explorer allocation", () => {
    const budget = (width: number, titleWidth: number) =>
      resolveInlineWorkspaceTabBudget({
        width,
        horizontalInset: 24,
        navigationWidth: 44,
        navigationGap: 8,
        titleWidth,
        gap: 16,
      });
    expect(budget(600, 240).titleWidth).toBe(192);
    expect(resolveInlineWorkspaceTabPresentation(budget(600, 240).railWidth, 300)).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(budget(450, 240).railWidth, 300)).toBe("switcher");
  });

  it("does not charge the navigation gap before navigation is measured", () => {
    expect(
      resolveInlineWorkspaceTabBudget({
        width: 600,
        horizontalInset: 24,
        navigationWidth: 0,
        navigationGap: 8,
        titleWidth: 100,
        gap: 16,
      }),
    ).toEqual({ titleWidth: 100, railWidth: 460 });
  });

  it("caps the title at the remaining width rather than the one-third share", () => {
    expect(
      resolveInlineWorkspaceTabBudget({
        width: 300,
        horizontalInset: 24,
        navigationWidth: 44,
        navigationGap: 8,
        titleWidth: 240,
        gap: 16,
      }),
    ).toEqual({ titleWidth: 92, railWidth: 116 });
  });

  it("returns rail space unused by a naturally narrower track to the title", () => {
    const width = (preferredTitleWidth: number, naturalRailWidth: number | null) =>
      resolveInlineWorkspaceTitleWidth({
        titleWidth: 178,
        preferredTitleWidth,
        railWidth: 288,
        naturalRailWidth,
      });
    expect(width(240, 180)).toBe(240);
    expect(width(240, null)).toBe(178);
    expect(width(240, 300)).toBe(178);
    expect(width(200, 180)).toBe(200);
  });

  it("never returns a negative rail budget", () => {
    expect(
      resolveInlineWorkspaceTabBudget({
        width: 20,
        horizontalInset: 24,
        navigationWidth: 44,
        navigationGap: 8,
        titleWidth: 240,
        gap: 16,
      }),
    ).toEqual({ titleWidth: 0, railWidth: 0 });
  });

  it("preserves embedded natural widths through fit and overflow, including the add button", () => {
    const fit = computeWorkspaceTabLayout({
      viewportWidth: 1000,
      tabLabelWidths: [80, 90],
      metrics,
      compact: false,
      preserveNaturalWidths: true,
    });
    const overflow = computeWorkspaceTabLayout({
      viewportWidth: 240,
      tabLabelWidths: [80, 90],
      metrics,
      compact: false,
      preserveNaturalWidths: true,
    });
    expect(overflow.items).toEqual(fit.items);
    expect(fit.requiresHorizontalScrollFallback).toBe(false);
    expect(overflow.requiresHorizontalScrollFallback).toBe(true);
    expect(workspaceTabNaturalWidth(overflow, metrics)).toBe(378);
  });
});

it("gives the tab switcher a readable popover width independent of its 16pt count badge", () => {
  const frame = buildDesktopFrameStyle({
    desktopMinWidth: workspaceTabSwitcherPopoverLayout.desktopMinWidth,
    desktopLockWidth: false,
    referenceWidth: 16,
    desktopFixedHeight: undefined,
    desktopPositionStyle: {},
    shouldHideDesktopContent: false,
    availableHeight: 600,
  }) as Array<{ minWidth?: number }>;
  expect(frame[0].minWidth).toBeGreaterThanOrEqual(320);
});
