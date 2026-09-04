import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitsSection } from "./commits-section";

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            borderRadius: { full: 9999, sm: 4 },
            borderWidth: { 1: 1 },
            colors: {
              border: "#333",
              foreground: "#fff",
              foregroundMuted: "#aaa",
              statusDanger: "#c33",
              surface2: "#222",
            },
            fontSize: { base: 15, sm: 13 },
            spacing: [0, 4, 8, 12],
          })
        : factory,
  },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/git/use-commits-query", () => ({
  useCheckoutCommitsQuery: () => ({ status: "idle" }),
}));

vi.mock("@/git/themed-chevron", () => ({
  ThemedChevron: () => null,
  chevronColorMapping: () => ({}),
}));

vi.mock("./commit-row", () => ({
  CommitRow: () => null,
}));

let root: Root | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

describe("CommitsSection", () => {
  it("keeps its bottom edge above the device safe area", () => {
    act(() => {
      root?.render(
        <CommitsSection serverId="server" cwd="/repo" onCommitPress={vi.fn()} collapsed />,
      );
    });

    const header = document.querySelector('[data-testid="commits-section-header"]');
    expect(header?.parentElement?.getAttribute("style")).toContain("padding-bottom: 34px");
  });
});
