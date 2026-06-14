import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffFile } from "@/git/use-diff-query";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13, code: 12 },
    fontFamily: { mono: "mono" },
    borderWidth: { 1: 1 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      surface1: "#111",
      surface2: "#222",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/styles/unistyles-inline-style", () => ({
  inlineUnistylesStyle: (style: Record<string, unknown>) => style,
}));

vi.mock("@/styles/code-surface", () => ({ CODE_SURFACE_DATASET: {} }));

// Heavy leaf components are mocked so this suite focuses on DiffFileBody's own
// branching (status messages vs. unified rows) without pulling in gesture-handler,
// the review module, or syntax highlighting. The unified-line row and split
// renderers have their own dedicated tests.
vi.mock("@/components/diff-scroll", () => ({
  DiffScroll: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "diff-scroll" }, children),
}));

vi.mock("@/git/diff-unified-line-row", () => ({
  DiffUnifiedLineRow: ({ lineNumber }: { lineNumber: number | null }) =>
    React.createElement("div", { "data-testid": "unified-row" }, String(lineNumber ?? "")),
  DiffGutterCell: ({ lineNumber }: { lineNumber: number | null }) =>
    React.createElement("div", { "data-testid": "gutter-cell" }, String(lineNumber ?? "")),
  LongPressableLine: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
  lineTypeBackground: () => ({}),
  styles: {
    diffTextMetrics: {},
    diffLineText: {},
    addLineText: {},
    removeLineText: {},
    headerLineText: {},
    contextLineText: {},
    diffLineContainer: {},
    lineNumberGutter: {},
  },
}));

vi.mock("@/git/diff-highlighted-text", () => ({
  HighlightedText: ({ tokens }: { tokens: { text: string }[] }) =>
    React.createElement("span", {}, tokens.map((token) => token.text).join("")),
  getWrappedTextStyle: () => ({}),
}));

vi.mock("@/review", () => ({
  getInlineReviewThreadState: () => null,
  getSplitInlineReviewThreadState: () => null,
  InlineReviewThread: () => null,
}));

import { DiffFileBody } from "./diff-file-body";

function makeFile(overrides: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return {
    path: "src/app.ts",
    additions: 1,
    deletions: 0,
    status: "modified",
    isNew: false,
    isDeleted: false,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          {
            type: "add",
            content: "const greeting = 1",
            tokens: [{ text: "const greeting = 1", style: null }],
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as ParsedDiffFile;
}

describe("DiffFileBody", () => {
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

  function render(file: ParsedDiffFile): void {
    act(() => {
      root?.render(
        <DiffFileBody file={file} layout="unified" wrapLines={false} codeFontSize={12} />,
      );
    });
  }

  it("renders unified gutter and code rows for a real diff file", () => {
    render(makeFile());

    expect(container?.querySelector('[data-testid="diff-scroll"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="gutter-cell"]')).not.toBeNull();
    expect(container?.textContent).toContain("const greeting = 1");
  });

  it("shows the binary message for a binary file", () => {
    render(makeFile({ status: "binary", hunks: [] }));

    expect(container?.textContent).toContain("workspace.git.diff.binaryFile");
    expect(container?.querySelector('[data-testid="diff-scroll"]')).toBeNull();
  });

  it("shows the too-large message for a truncated file", () => {
    render(makeFile({ status: "too_large", hunks: [] }));

    expect(container?.textContent).toContain("workspace.git.diff.tooLarge");
    expect(container?.querySelector('[data-testid="diff-scroll"]')).toBeNull();
  });
});
