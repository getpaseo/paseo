import { describe, expect, it } from "vitest";
import {
  SIDEBAR_FOOTER_DEFAULT_HEIGHT,
  SIDEBAR_NAV_GROUP_CHROME_RESERVE,
  SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
  resolveSidebarNavGroupHeight,
  resolveSidebarNavGroupMaxHeight,
} from "./group-layout";

describe("resolveSidebarNavGroupMaxHeight", () => {
  it("caps the group at a third of the window", () => {
    expect(resolveSidebarNavGroupMaxHeight(900)).toBe(300);
    expect(resolveSidebarNavGroupMaxHeight(1000)).toBe(333);
  });

  it("keeps the fraction on the shortest windows the app runs at", () => {
    expect(resolveSidebarNavGroupMaxHeight(360)).toBe(120);
    expect(resolveSidebarNavGroupMaxHeight(200)).toBe(67);
    expect(resolveSidebarNavGroupMaxHeight(108)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
  });

  it("shows one row rather than nothing when the viewport is unusable", () => {
    expect(resolveSidebarNavGroupMaxHeight(60)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(0)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.NaN)).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
    expect(resolveSidebarNavGroupMaxHeight(Number.POSITIVE_INFINITY)).toBe(
      SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT,
    );
  });
});

describe("resolveSidebarNavGroupHeight", () => {
  it("uses the default share until the owner drags the group", () => {
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: null,
        viewportHeight: 900,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(300);
  });

  it("honours a dragged height between one row and half the window", () => {
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 480,
        viewportHeight: 900,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(450);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 120,
        viewportHeight: 900,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(120);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 10,
        viewportHeight: 900,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(SIDEBAR_NAV_GROUP_MIN_MAX_HEIGHT);
  });

  it("leaves the sidebar's own chrome room on a short window", () => {
    // A 200px window can spare 200 minus the header, footer and one workspace row.
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 200,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(200 - SIDEBAR_NAV_GROUP_CHROME_RESERVE);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 900,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(450);
  });

  it("reserves compact header and workspace row heights when dragging", () => {
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 260,
        footerHeight: 80,
      }),
    ).toBe(108);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 260,
        footerHeight: 80,
        rowHeight: 44,
      }),
    ).toBe(92);
  });

  it("shrinks the dragged cap when the measured footer is taller", () => {
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 300,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(150);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 300,
        footerHeight: 120,
      }),
    ).toBe(108);
  });

  it("never lets the ceiling fall below the default share", () => {
    // Windows this short have no chrome budget at all, so the default share holds.
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 100,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(resolveSidebarNavGroupMaxHeight(100));
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 60,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(resolveSidebarNavGroupMaxHeight(60));
  });

  it("falls back to the default share when the height is not a number", () => {
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: Number.NaN,
        viewportHeight: 600,
        footerHeight: SIDEBAR_FOOTER_DEFAULT_HEIGHT,
      }),
    ).toBe(200);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 200,
        footerHeight: Number.NaN,
      }),
    ).toBe(200 - SIDEBAR_NAV_GROUP_CHROME_RESERVE);
    expect(
      resolveSidebarNavGroupHeight({
        requestedHeight: 900,
        viewportHeight: 120,
        footerHeight: -20,
      }),
    ).toBe(48);
  });
});
