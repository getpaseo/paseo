import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
  PortalHost: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            colors: { popover: "#fff", borderAccent: "#ccc" },
            borderWidth: [0, 1],
            borderRadius: { xl: 12 },
            shadow: { md: {} },
          })
        : factory,
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function hoverTrigger(): void {
  const trigger = document.querySelector('[data-testid="trigger"]')?.parentElement;
  expect(trigger).toBeTruthy();
  act(() => {
    trigger!.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true }));
  });
}

describe("HoverCard on web", () => {
  it("renders its content in the overlay root, above the workspace browser", () => {
    act(() => {
      root?.render(
        <HoverCard>
          <HoverCardTrigger>
            <Text testID="trigger">Context window</Text>
          </HoverCardTrigger>
          <HoverCardContent placement="top">
            <Text>17% used</Text>
          </HoverCardContent>
        </HoverCard>,
      );
    });

    hoverTrigger();

    const card = [...document.querySelectorAll("div")].find((el) => el.textContent === "17% used");
    expect(card).toBeTruthy();
    expect(document.getElementById("overlay-root")?.contains(card!)).toBe(true);
    expect(container?.contains(card!)).toBe(false);
  });
});
