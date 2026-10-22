import { describe, expect, it } from "vitest";
import { resolveCompactLayout } from "./tablet-layout";

const tablet = {
  android: true,
  compactBreakpoint: false,
  width: 1280,
  height: 800,
  landscape: "desktop",
  portrait: "phone",
} as const;
describe("tablet orientation layouts", () => {
  it("defaults to desktop in landscape and phone in portrait", () => {
    expect(resolveCompactLayout(tablet)).toBe(false);
    expect(resolveCompactLayout({ ...tablet, width: 800, height: 1280 })).toBe(true);
  });
  it("allows each orientation to be overridden independently", () => {
    expect(resolveCompactLayout({ ...tablet, landscape: "phone" })).toBe(true);
    expect(resolveCompactLayout({ ...tablet, width: 800, height: 1280, portrait: "desktop" })).toBe(
      false,
    );
    expect(resolveCompactLayout({ ...tablet, portrait: "desktop" })).toBe(false);
    expect(resolveCompactLayout({ ...tablet, width: 800, height: 1280, landscape: "phone" })).toBe(
      true,
    );
  });
  it.each([
    { width: 412, height: 915 },
    { width: 915, height: 412 },
    { width: 599, height: 1000 },
  ])("keeps phone and narrow-window behavior at %o", (size) => {
    expect(resolveCompactLayout({ ...tablet, ...size, compactBreakpoint: true })).toBe(true);
    expect(resolveCompactLayout({ ...tablet, ...size, compactBreakpoint: false })).toBe(false);
  });
  it("recognizes 600dp tablets even when Android system bars reduce the landscape window height", () => {
    expect(
      resolveCompactLayout({
        ...tablet,
        width: 960,
        height: 552,
        screenWidth: 960,
        screenHeight: 600,
      }),
    ).toBe(false);
    expect(
      resolveCompactLayout({
        ...tablet,
        width: 960,
        height: 552,
        screenWidth: 960,
        screenHeight: 600,
        landscape: "phone",
      }),
    ).toBe(true);
    expect(
      resolveCompactLayout({
        ...tablet,
        width: 400,
        height: 800,
        screenWidth: 1280,
        screenHeight: 800,
        compactBreakpoint: true,
      }),
    ).toBe(true);
  });
  it("keeps the portrait preference when the keyboard reduces the app window height", () => {
    expect(
      resolveCompactLayout({
        ...tablet,
        width: 600,
        height: 400,
        screenWidth: 600,
        screenHeight: 960,
      }),
    ).toBe(true);
  });
  it("includes 600dp tablets and leaves web and iOS behavior unchanged", () => {
    expect(resolveCompactLayout({ ...tablet, width: 600, height: 960 })).toBe(true);
    expect(resolveCompactLayout({ ...tablet, android: false, width: 800, height: 1280 })).toBe(
      false,
    );
  });
});
