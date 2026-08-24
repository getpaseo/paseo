/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12 },
    iconSize: { sm: 14, md: 18 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15, code: 12 },
    fontWeight: { normal: "400", medium: "500" },
    fontFamily: { sans: "sans-serif", mono: "monospace" },
    shadow: { md: {} },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#444",
      borderAccent: "#555",
      palette: {
        green: { 500: "#22c55e" },
        amber: { 500: "#f59e0b" },
        red: { 500: "#ef4444" },
        blue: { 500: "#3b82f6" },
        zinc: { 600: "#52525b" },
      },
    },
  },
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (Comp: unknown) => Comp,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "workspace.fileExplorer.context.size") return "Size";
      if (key === "workspace.fileExplorer.context.modified") return "Modified";
      return key;
    },
  }),
  initReactI18next: {
    type: "3rdParty",
    init: () => {},
  },
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { FileExplorerMetaHeader } from "./file-explorer-pane";

describe("FileExplorerMetaHeader", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T10:00:00Z"));
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
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("calculates modified time ago dynamically when mounted", () => {
    const fileModifiedAt = new Date("2026-07-30T09:50:00Z").getTime(); // 10 mins before 10:00

    // Render at 10:00:00
    act(() => {
      root?.render(<FileExplorerMetaHeader size={2048} modifiedAt={fileModifiedAt} />);
    });

    expect(container?.textContent).toContain("Size");
    expect(container?.textContent).toContain("2.0 KB");
    expect(container?.textContent).toContain("Modified");
    expect(container?.textContent).toContain("10m ago");

    // Unmount (simulating menu closed)
    act(() => {
      root?.render(null);
    });

    // Advance clock by 30 minutes to 10:30:00
    vi.setSystemTime(new Date("2026-07-30T10:30:00Z"));

    // Render again at 10:30:00 (simulating menu opening later)
    act(() => {
      root?.render(<FileExplorerMetaHeader size={2048} modifiedAt={fileModifiedAt} />);
    });

    // Modified time ago must compute 40m ago instead of stale 10m ago
    expect(container?.textContent).toContain("40m ago");
  });
});
