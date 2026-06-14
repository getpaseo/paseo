import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HighlightToken } from "@/git/use-diff-query";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 3: 12 },
    fontSize: { code: 12 },
    lineHeight: { diff: 18 },
    fontFamily: { mono: "mono" },
    colors: {
      foreground: "#fff",
      syntax: { keyword: "#c0f", string: "#0fc" },
    },
  },
}));

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("@/constants/platform", () => ({ isNative: false }));

import { HighlightedText } from "./diff-highlighted-text";

describe("HighlightedText", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
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

  function render(tokens: HighlightToken[]): void {
    act(() => {
      root?.render(<HighlightedText tokens={tokens} testID="line" />);
    });
  }

  it("renders one span per token, preserving token text", () => {
    render([
      { text: "const", style: "keyword" },
      { text: " x = ", style: null },
      { text: '"hi"', style: "string" },
    ]);

    const spans = container?.querySelectorAll("span") ?? [];
    // 1 container span + 3 token spans.
    expect(spans.length).toBe(4);
    expect(container?.textContent).toBe('const x = "hi"');
  });

  it("renders an empty container for no tokens", () => {
    render([]);

    expect(container?.textContent).toBe("");
    expect(container?.querySelector('[data-testid="line"]')).not.toBeNull();
  });
});
