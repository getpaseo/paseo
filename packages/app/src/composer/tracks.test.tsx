/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
  },
  Pressable: "button",
  Text: "span",
  // The status ring reaches for plain React Native styles rather than Unistyles ones — see the
  // note on `rotatorStyles` in status-ring/frame.tsx.
  StyleSheet: { create: <T,>(styles: T): T => styles },
  View: ({
    children,
    style,
    onLayout,
  }: {
    children?: React.ReactNode;
    style?: unknown;
    onLayout?: unknown;
  }) => (
    <div data-style={JSON.stringify(style)} data-has-layout-handler={Boolean(onLayout)}>
      {children}
    </div>
  ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: Record<string, unknown>) => unknown) =>
      factory({
        spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
        borderRadius: { md: 6, lg: 8, xl: 12, "2xl": 16, full: 9999 },
        borderWidth: { 1: 1 },
        fontSize: { sm: 12 },
        colors: {
          statusDotWarning: "#1",
          statusDotDanger: "#2",
          statusDotRunning: "#3",
          statusDotSuccess: "#4",
          border: "#5",
          surface2: "#6",
          borderAccent: "#7",
          surface1: "#8",
          foregroundMuted: "#9",
          foreground: "#a",
        },
      }),
  },
}));

vi.mock("@/components/ui/menu", () => ({
  MenuRoot: ({ children }: { children?: React.ReactNode }) => children,
  MenuSurface: ({ children }: { children?: React.ReactNode }) => children,
  MenuTrigger: ({ children }: { children?: React.ReactNode }) => children,
  useMenuContext: () => ({ open: false }),
}));

import { ComposerTrackBar } from "./tracks";
import {
  COMPOSER_PILL_CLEARANCE,
  composerPillStyles,
  resolveComposerPillClearance,
  resolveComposerTrackTailClearance,
} from "./pill-styles";

describe("ComposerTrackBar", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("floats over content without painting a background band", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<ComposerTrackBar>track</ComposerTrackBar>));

    const style = JSON.parse(container.firstElementChild?.getAttribute("data-style") ?? "{}");
    expect(style).toMatchObject({
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingBottom: { xs: 16, md: 10 },
    });
    expect(style).not.toHaveProperty("backgroundColor");
    expect(container.firstElementChild?.getAttribute("data-has-layout-handler")).toBe("false");

    const trackStyle = JSON.parse(
      container.firstElementChild?.firstElementChild?.getAttribute("data-style") ?? "{}",
    );
    expect(trackStyle).toMatchObject({ flexDirection: "row" });
    expect(trackStyle).not.toHaveProperty("flexWrap");
  });

  it("matches the composer's corner tangent without radius clamping", () => {
    expect(composerPillStyles.body).toMatchObject({
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 16,
    });
    expect(composerPillStyles.label).toMatchObject({ fontSize: 12 });
    expect(resolveComposerPillClearance(true)).toBe(16);
    expect(resolveComposerPillClearance(false)).toBe(10);
    expect(resolveComposerTrackTailClearance(true)).toBe(64);
    expect(resolveComposerTrackTailClearance(false)).toBe(52);
    expect(COMPOSER_PILL_CLEARANCE).toEqual({ compact: 16, wide: 10 });
  });
});
