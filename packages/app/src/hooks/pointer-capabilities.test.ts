import { describe, expect, it } from "vitest";
import {
  createNativePointerCapabilitiesSource,
  createPointerCapabilitiesSource,
} from "./pointer-capabilities";
import {
  hasFinePointer as hasGpuiFinePointer,
  hasTouchPrimaryPointer as hasGpuiTouchPrimaryPointer,
  usePointerCapabilities as useGpuiPointerCapabilities,
} from "./pointer-capabilities.gpui";

class FakeMediaQueryList {
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly media: string,
    public matches: boolean,
  ) {}

  addEventListener(_type: "change", listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: () => void) {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean) {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

function createFakeDisplay(initial: {
  finePointer: boolean;
  touchScreen: boolean;
  touchPrimaryPointer?: boolean;
}) {
  const queries = {
    finePointer: new FakeMediaQueryList("(hover: hover) and (pointer: fine)", initial.finePointer),
    touchScreen: new FakeMediaQueryList("(any-pointer: coarse)", initial.touchScreen),
    touchPrimaryPointer: new FakeMediaQueryList(
      "(pointer: coarse)",
      initial.touchPrimaryPointer ?? false,
    ),
  };
  const matchMedia = (query: string) => {
    const match = Object.values(queries).find((list) => list.media === query);
    if (!match) throw new Error(`Unexpected media query ${query}`);
    return match as unknown as MediaQueryList;
  };
  return { queries, matchMedia };
}

describe("pointer capabilities", () => {
  it("reports a hybrid touch laptop as both a fine pointer and a touch screen", () => {
    const display = createFakeDisplay({ finePointer: true, touchScreen: true });
    const source = createPointerCapabilitiesSource(display.matchMedia);

    expect(source.getSnapshot()).toEqual({ finePointer: true, touchScreen: true });
  });

  it("notifies and updates the touch answer when a touch screen appears or goes away", () => {
    const display = createFakeDisplay({ finePointer: true, touchScreen: false });
    const source = createPointerCapabilitiesSource(display.matchMedia);
    const seen: boolean[] = [];
    const unsubscribe = source.subscribe(() => seen.push(source.getSnapshot().touchScreen));

    display.queries.touchScreen.setMatches(true);
    display.queries.touchScreen.setMatches(false);
    unsubscribe();
    display.queries.touchScreen.setMatches(true);

    expect(seen).toEqual([true, false]);
  });

  it("keeps one snapshot until an answer changes", () => {
    const display = createFakeDisplay({ finePointer: false, touchScreen: true });
    const source = createPointerCapabilitiesSource(display.matchMedia);
    const first = source.getSnapshot();

    expect(source.getSnapshot()).toBe(first);
    display.queries.finePointer.setMatches(true);
    expect(source.getSnapshot()).toEqual({ finePointer: true, touchScreen: true });
  });

  it("reports neither capability without media queries", () => {
    expect(createPointerCapabilitiesSource(null).getSnapshot()).toEqual({
      finePointer: false,
      touchScreen: false,
    });
  });
});

describe("hasTouchPrimaryPointer", () => {
  it("is false on a touch-screen laptop driven by its trackpad", () => {
    const display = createFakeDisplay({ finePointer: true, touchScreen: true });
    expect(createPointerCapabilitiesSource(display.matchMedia).hasTouchPrimaryPointer()).toBe(
      false,
    );
  });

  it("is true when the primary pointer is coarse", () => {
    const display = createFakeDisplay({
      finePointer: false,
      touchScreen: true,
      touchPrimaryPointer: true,
    });
    expect(createPointerCapabilitiesSource(display.matchMedia).hasTouchPrimaryPointer()).toBe(true);
  });

  it("is false without media queries", () => {
    expect(createPointerCapabilitiesSource(null).hasTouchPrimaryPointer()).toBe(false);
  });
});

describe("pointer capabilities per target", () => {
  it("reports a coarse touch primary pointer on native iOS/Android", () => {
    const nativeSource = createNativePointerCapabilitiesSource();
    expect(nativeSource.getSnapshot()).toEqual({ finePointer: false, touchScreen: true });
    expect(nativeSource.hasTouchPrimaryPointer()).toBe(true);
  });

  it("reports fine pointer without touch screen on desktop web/Electron", () => {
    const desktopDisplay = createFakeDisplay({
      finePointer: true,
      touchScreen: false,
      touchPrimaryPointer: false,
    });
    const desktopSource = createPointerCapabilitiesSource(desktopDisplay.matchMedia);
    expect(desktopSource.getSnapshot()).toEqual({ finePointer: true, touchScreen: false });
    expect(desktopSource.hasTouchPrimaryPointer()).toBe(false);
  });

  it("reports fine pointer without touch screen on GPUI", () => {
    expect(useGpuiPointerCapabilities()).toEqual({ finePointer: true, touchScreen: false });
    expect(hasGpuiFinePointer()).toBe(true);
    expect(hasGpuiTouchPrimaryPointer()).toBe(false);
  });
});
