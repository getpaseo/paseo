import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SPACING } from "@/styles/theme";
import { PageLayout } from "./index";

const platform = vi.hoisted(() => ({ os: "ios" }));

vi.mock("react-native", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-native")>();
  return {
    ...original,
    Platform: {
      ...original.Platform,
      get OS() {
        return platform.os;
      },
    },
    ScrollView: ({ children }: { children: React.ReactNode }) => (
      <section data-scroll="plain">{children}</section>
    ),
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAwareScrollView: ({
    children,
    bottomOffset,
  }: {
    children: React.ReactNode;
    bottomOffset: number;
  }) => (
    <section data-scroll="keyboard-aware" data-offset={bottomOffset}>
      {children}
    </section>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }),
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => true }));
vi.mock("@/components/headers/back-header", () => ({ BackHeader: () => null }));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
vi.mock("@/components/ui/press-highlight", () => ({ PressHighlight: () => null }));

beforeEach(() => {
  platform.os = "ios";
});

function layout(keyboardAware: boolean) {
  return renderToStaticMarkup(
    <PageLayout keyboardAware={keyboardAware}>
      <span>Settings fields</span>
    </PageLayout>,
  );
}

describe("settings keyboard scrolling", () => {
  it("uses keyboard-aware scrolling with room for plugin fields on iOS", () => {
    expect(layout(true)).toContain(`data-scroll="keyboard-aware" data-offset="${SPACING[4]}"`);
    expect(layout(true)).toContain("Settings fields");
  });

  it("keeps other iOS pages on their existing scroll view", () => {
    expect(layout(false)).toContain('data-scroll="plain"');
  });

  it("keeps Android keyboard-aware and web on the ordinary scroll view", () => {
    platform.os = "android";
    expect(layout(false)).toContain(`data-scroll="keyboard-aware" data-offset="${SPACING[4]}"`);
    platform.os = "web";
    expect(layout(true)).toContain('data-scroll="plain"');
  });
});
