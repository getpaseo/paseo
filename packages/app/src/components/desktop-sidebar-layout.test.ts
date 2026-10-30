import { describe, expect, it } from "vitest";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";
import {
  resolveSidebarFooterLayout,
  resolveSidebarFooterKeyboardSpacing,
  SIDEBAR_FOOTER_GROUP_GAP,
  SIDEBAR_FOOTER_MIN_BUTTON_WIDTH,
  SIDEBAR_FOOTER_ROW_PADDING,
} from "@/components/sidebar-footer-layout";
import { MIN_SIDEBAR_WIDTH, usePanelStore } from "@/stores/panel-store";
import {
  resolveContentBandPlacement,
  resolveLeadingCornerControlInset,
} from "@/components/headers/content-band-geometry.shared";

describe("desktop sidebar layout", () => {
  it("projects corner clearance from the current sidebar allocation without a new native sample", () => {
    const systemGeometry = {
      leadingCornerInset: 0,
      requiresLeadingCornerSlot: true,
      rowHeight: 36,
      horizontalPadding: 12,
      leftInset: 0,
    };
    const resolve = (leadingOffset: number) =>
      resolveLeadingCornerControlInset({
        ...systemGeometry,
        leadingOffset,
      });
    expect([resolve(0), resolve(200), resolve(0)]).toEqual([24, 0, 24]);
    expect(
      resolveLeadingCornerControlInset({
        ...systemGeometry,
        leadingOffset: 0,
        rowHeight: 56,
      }),
    ).toBe(44);
  });

  it("credits existing left clearance and preserves larger system corner requirements", () => {
    expect(
      resolveLeadingCornerControlInset({
        leadingCornerInset: 60,
        requiresLeadingCornerSlot: false,
        leadingOffset: 20,
        rowHeight: 36,
        horizontalPadding: 12,
        leftInset: 8,
      }),
    ).toBe(20);
    expect(
      resolveLeadingCornerControlInset({
        leadingCornerInset: 0,
        requiresLeadingCornerSlot: false,
        leadingOffset: 0,
        rowHeight: 36,
        horizontalPadding: 12,
        leftInset: 0,
      }),
    ).toBe(0);
  });

  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({
      requestedWidth: 600,
      viewportWidth: 751,
      minimumWidth: MIN_SIDEBAR_WIDTH,
    });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({
      requestedWidth: 600,
      viewportWidth: 720,
      minimumWidth: MIN_SIDEBAR_WIDTH,
    });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(
      resolveDesktopSidebarWidth({
        requestedWidth: 600,
        viewportWidth: 1440,
        minimumWidth: MIN_SIDEBAR_WIDTH,
      }),
    ).toBe(600);
  });

  it("yields app navigation when settings needs the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({ isSettingsRoute: true });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        sidebarMinimumWidth: MIN_SIDEBAR_WIDTH,
        viewportWidth: 751,
      }),
    ).toBe(false);
  });

  it("imposes no content minimum outside settings", () => {
    expect(resolveDesktopAppContentMinimum({ isSettingsRoute: false })).toBe(0);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({ isSettingsRoute: false }),
        requestedSidebarWidth: 320,
        sidebarMinimumWidth: MIN_SIDEBAR_WIDTH,
        viewportWidth: 751,
      }),
    ).toBe(true);
  });
  it.each([
    { width: 260, expectedButtonWidth: 44 },
    { width: 200, expectedButtonWidth: 32 },
    { width: 180, expectedButtonWidth: 28 },
  ])(
    "shares a $width px footer equally across all five controls",
    ({ width, expectedButtonWidth }) => {
      const layout = resolveSidebarFooterLayout({
        width,
        buttonSize: 56 - 2 * SIDEBAR_FOOTER_ROW_PADDING,
        edgeInsets: { left: 0, right: 0 },
      });
      expect(layout.buttonWidth).toBe(expectedButtonWidth);
      const leftGroupWidth = 3 * layout.buttonWidth;
      const rightGroupWidth = 2 * layout.buttonWidth;
      const groupGap =
        width - layout.paddingLeft - layout.paddingRight - leftGroupWidth - rightGroupWidth;
      expect(groupGap).toBeGreaterThanOrEqual(SIDEBAR_FOOTER_GROUP_GAP);
      if (layout.buttonWidth < 44) expect(groupGap).toBe(SIDEBAR_FOOTER_GROUP_GAP);
    },
  );

  it("uses system margins once while keeping all control hit areas inside the rail", () => {
    const layout = resolveSidebarFooterLayout({
      width: 200,
      buttonSize: 44,
      edgeInsets: { left: 16, right: 12 },
    });
    expect(layout.paddingLeft).toBe(16);
    expect(layout.paddingRight).toBe(12);
    expect(layout.buttonWidth).toBeGreaterThanOrEqual(SIDEBAR_FOOTER_MIN_BUTTON_WIDTH);
    expect(
      200 - layout.paddingLeft - layout.paddingRight - 5 * layout.buttonWidth,
    ).toBeGreaterThanOrEqual(SIDEBAR_FOOTER_GROUP_GAP);
  });

  const band = {
    width: 466,
    height: 56,
    margins: { left: 0, right: 0 },
    minimumInsets: { left: 8, right: 8 },
    minimumContentWidth: 164,
    direction: "up" as const,
    placementBounds: { x: 0, y: -598, width: 466, height: 678 },
  };

  it("does not reserve the top camera rail for bottom controls", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      margins: { left: 0, right: 25 / 3 },
      exclusions: [{ x: 382, y: -598, width: 84, height: 240 }],
    });
    expect(placement.kind).toBe("placed");
    if (placement.kind !== "placed") throw new Error("Expected a bottom control rail");
    expect(placement.offsetY).toBe(0);
    const layout = resolveSidebarFooterLayout({
      width: 466,
      buttonSize: 44,
      edgeInsets: placement.insets,
    });
    expect(layout.paddingRight).toBeCloseTo(25 / 3);
    expect(layout.buttonWidth).toBe(44);
  });

  it("moves to the nearest owner boundary when the resting band exceeds it", () => {
    expect(
      resolveContentBandPlacement({
        ...band,
        placementBounds: { x: 0, y: -598, width: 466, height: 644 },
        exclusions: [],
      }),
    ).toEqual({
      kind: "placed",
      insets: { left: 8, right: 8 },
      offsetY: -10,
      availableWidth: 450,
    });
  });

  it("keeps the close hit target clear of a partially overlapping camera", () => {
    const camera = { x: 382, y: 16, width: 84, height: 100 };
    const placement = resolveContentBandPlacement({
      ...band,
      height: 44,
      minimumContentWidth: 64,
      direction: "down",
      placementBounds: { x: 0, y: -8, width: 466, height: 678 },
      exclusions: [camera],
    });
    expect(placement.kind).toBe("placed");
    if (placement.kind !== "placed") throw new Error("Expected a close-button rail");
    expect(466 - placement.insets.right).toBeLessThanOrEqual(camera.x);
    expect(placement.offsetY).toBe(0);
    expect(placement.availableWidth).toBeGreaterThanOrEqual(64);
  });

  it("moves below a narrow top gap rather than forcing a close button into it", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      width: 100,
      height: 40,
      minimumContentWidth: 32,
      direction: "down",
      placementBounds: { x: 0, y: 0, width: 100, height: 200 },
      exclusions: [{ x: 30, y: 0, width: 70, height: 60 }],
    });
    expect(placement).toEqual({
      kind: "placed",
      insets: { left: 8, right: 8 },
      offsetY: 60,
      availableWidth: 84,
    });
  });

  it("moves a complete footer above an active full-width division", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      exclusions: [{ x: 0, y: -10, width: 466, height: 60 }],
    });
    expect(placement).toEqual({
      kind: "placed",
      insets: { left: 8, right: 8 },
      offsetY: -66,
      availableWidth: 450,
    });
  });

  it("does not jump into another reserved region when moving vertically", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      height: 40,
      direction: "down",
      placementBounds: { x: 0, y: 0, width: 466, height: 300 },
      exclusions: [
        { x: 0, y: 0, width: 466, height: 60 },
        { x: 0, y: 60, width: 466, height: 60 },
      ],
    });
    expect(placement.kind).toBe("placed");
    if (placement.kind !== "placed") throw new Error("Expected a second available band");
    expect(placement.offsetY).toBe(120);
    expect(placement.availableWidth).toBeGreaterThanOrEqual(band.minimumContentWidth);
  });

  it("reports no fit explicitly when the owner has no room for the minimum target", () => {
    expect(
      resolveContentBandPlacement({
        ...band,
        width: 100,
        height: 40,
        direction: "down",
        minimumContentWidth: 32,
        placementBounds: { x: 0, y: 0, width: 100, height: 80 },
        exclusions: [{ x: 30, y: 0, width: 70, height: 80 }],
      }),
    ).toEqual({ kind: "unavailable", availableWidth: 22, requiredWidth: 32 });
  });

  it("merges overlapping exclusions without duplicating their interactive margins", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      width: 500,
      margins: { left: 12, right: 10 },
      exclusions: [
        { x: 480, y: 30, width: 80, height: 40 },
        { x: 130, y: 0, width: 100, height: 56 },
        { x: 100, y: 0, width: 50, height: 56 },
      ],
    });
    expect(placement.kind).toBe("placed");
    if (placement.kind !== "placed") throw new Error("Expected a contiguous rail");
    expect(placement.insets).toEqual({ left: 230, right: 20 });
    expect(placement.offsetY).toBe(0);
  });

  it("does not displace controls for a region merely touching the row boundary", () => {
    const placement = resolveContentBandPlacement({
      ...band,
      exclusions: [{ x: 300, y: -10, width: 166, height: 10 }],
    });
    expect(placement.kind).toBe("placed");
    if (placement.kind !== "placed") throw new Error("Expected the resting rail");
    expect(placement.offsetY).toBe(0);
    expect(placement.insets).toEqual({ left: 8, right: 8 });
  });

  it("keeps the footer at the keyboard edge without stacking the native resting clearance", () => {
    const spacing = resolveSidebarFooterKeyboardSpacing({
      keyboardHeight: -264,
      layoutShift: 230,
      restingBottom: 28,
    });
    expect(669 - 28 - spacing).toBe(405);
  });

  it("follows the first overlapping keyboard frame before the full keyboard height arrives", () => {
    expect(
      resolveSidebarFooterKeyboardSpacing({
        keyboardHeight: -40,
        layoutShift: 230,
        restingBottom: 28,
      }),
    ).toBe(12);
  });

  it("leaves the resting footer unchanged for an accessory-only keyboard", () => {
    expect(
      resolveSidebarFooterKeyboardSpacing({
        keyboardHeight: -80,
        layoutShift: 0,
        restingBottom: 28,
      }),
    ).toBe(0);
  });

  it("keeps the button minimum when preferred or available width is smaller", () => {
    expect(
      resolveSidebarFooterLayout({
        width: 100,
        buttonSize: 20,
        edgeInsets: { left: 0, right: 0 },
      }).buttonWidth,
    ).toBe(SIDEBAR_FOOTER_MIN_BUTTON_WIDTH);
  });

  it("clamps the sidebar to live geometry while retaining the existing width floor", () => {
    expect(
      resolveDesktopSidebarWidth({ requestedWidth: 100, viewportWidth: 951, minimumWidth: 180 }),
    ).toBe(200);
    expect(
      resolveDesktopSidebarWidth({ requestedWidth: 200, viewportWidth: 951, minimumWidth: 240 }),
    ).toBe(240);
    expect(
      resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 620, minimumWidth: 240 }),
    ).toBe(240);
  });

  it("shares the measured sidebar minimum with the shell", () => {
    const input = { contentMinimumWidth: 600, requestedSidebarWidth: 200, viewportWidth: 820 };
    expect(canDesktopAppSidebarShare({ ...input, sidebarMinimumWidth: 200 })).toBe(true);
    expect(canDesktopAppSidebarShare({ ...input, sidebarMinimumWidth: 240 })).toBe(false);
  });

  it("restores the requested width when transient geometry relaxes without persisting it", () => {
    const previous = usePanelStore.getState();
    try {
      previous.setSidebarWidth(220);
      previous.setSidebarMinimumWidth(260);
      const constrained = usePanelStore.getState();
      expect(constrained.sidebarWidth).toBe(220);
      expect(
        resolveDesktopSidebarWidth({
          requestedWidth: constrained.sidebarWidth,
          minimumWidth: constrained.sidebarMinimumWidth,
          viewportWidth: 951,
        }),
      ).toBe(260);
      constrained.setSidebarMinimumWidth(260);
      expect(usePanelStore.getState()).toBe(constrained);
      const persisted = usePanelStore.persist.getOptions().partialize?.(constrained);
      expect(persisted).not.toHaveProperty("sidebarMinimumWidth");
      expect(persisted).toHaveProperty("sidebarWidth", 220);

      constrained.setSidebarMinimumWidth(180);
      const relaxed = usePanelStore.getState();
      expect(relaxed.sidebarMinimumWidth).toBe(MIN_SIDEBAR_WIDTH);
      expect(relaxed.sidebarWidth).toBe(220);
      expect(
        resolveDesktopSidebarWidth({
          requestedWidth: relaxed.sidebarWidth,
          minimumWidth: relaxed.sidebarMinimumWidth,
          viewportWidth: 951,
        }),
      ).toBe(220);
    } finally {
      previous.setSidebarWidth(previous.sidebarWidth);
      previous.setSidebarMinimumWidth(previous.sidebarMinimumWidth);
    }
  });
});

it("reserves room for Explorer and the workspace before showing app navigation", () => {
  const contentMinimumWidth = resolveDesktopAppContentMinimum({
    isSettingsRoute: false,
    explorerVisible: true,
  });
  expect(contentMinimumWidth).toBe(600);
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 320,
      sidebarMinimumWidth: MIN_SIDEBAR_WIDTH,
      viewportWidth: 744,
    }),
  ).toBe(false);
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 320,
      sidebarMinimumWidth: MIN_SIDEBAR_WIDTH,
      viewportWidth: 951,
    }),
  ).toBe(true);
});
