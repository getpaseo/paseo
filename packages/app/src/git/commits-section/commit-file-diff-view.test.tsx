import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    fontSize: { xs: 11, sm: 13, code: 12 },
    lineHeight: { diff: 18 },
    fontFamily: { ui: "ui", mono: "mono" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
      statusDanger: "#f00",
      syntax: {
        keyword: "#c0f",
        string: "#0fc",
      },
    },
  },
}));

const { commitFileDiff } = vi.hoisted(() => ({
  commitFileDiff: {
    value: null as { file: ParsedDiffFile | null; isLoading: boolean; error: Error | null } | null,
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-icon": "spinner" }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { codeFontSize: 12 } }),
}));

vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));

vi.mock("@/git/use-commit-file-diff", () => ({
  useCommitFileDiff: () => commitFileDiff.value,
}));

import { CommitFileDiffView } from "./commit-file-diff-view";

function makeFile(): ParsedDiffFile {
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
            tokens: [
              { text: "const", style: "keyword" },
              { text: " greeting = 1", style: null },
            ],
          },
        ],
      },
    ],
  } as unknown as ParsedDiffFile;
}

describe("CommitFileDiffView", () => {
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
    commitFileDiff.value = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(
        <CommitFileDiffView serverId="server-1" cwd="/tmp/repo" sha="abc" path="src/app.ts" />,
      );
    });
  }

  it("renders highlighted token text and the gutter line number", () => {
    commitFileDiff.value = { file: makeFile(), isLoading: false, error: null };
    render();

    // Syntax-highlighted tokens render as separate spans whose combined text is the line.
    expect(container?.textContent).toContain("const");
    expect(container?.textContent).toContain("greeting = 1");
    // The gutter shows the new-side line number for an added line.
    expect(container?.textContent).toContain("1");
  });

  it("shows the loading spinner while loading", () => {
    commitFileDiff.value = { file: null, isLoading: true, error: null };
    render();

    expect(container?.querySelector('[data-icon="spinner"]')).not.toBeNull();
  });

  it("shows the empty message when there are no diff lines", () => {
    const file = makeFile();
    file.hunks = [];
    commitFileDiff.value = { file, isLoading: false, error: null };
    render();

    expect(container?.textContent).toContain("workspace.git.diff.commits.fileDiffEmpty");
  });
});
