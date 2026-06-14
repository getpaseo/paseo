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
}));

// DiffFileBody is the shared body renderer that the Changes panel also uses; it
// has its own dedicated render test (diff-file-body.test.tsx). Here we mock it to
// keep this suite focused on the commit view's own logic (loading/empty/error
// states and that a real ParsedDiffFile is forwarded with the resolved props).
const { lastDiffFileBodyProps } = vi.hoisted(() => ({
  lastDiffFileBodyProps: {
    value: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/git/diff-file-body", () => ({
  DiffFileBody: (props: { file: { path: string } }) => {
    lastDiffFileBodyProps.value = props;
    return React.createElement("div", { "data-testid": "diff-file-body" }, props.file.path);
  },
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

vi.mock("@/hooks/use-changes-preferences", () => ({
  useChangesPreferences: () => ({
    preferences: { wrapLines: false, layout: "unified", fileView: "list", hideWhitespace: false },
  }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
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
    lastDiffFileBodyProps.value = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(
        <CommitFileDiffView serverId="server-1" cwd="/tmp/repo" sha="abc" path="src/app.ts" />,
      );
    });
  }

  it("renders the diff through the shared DiffFileBody with resolved props", () => {
    const file = makeFile();
    commitFileDiff.value = { file, isLoading: false, error: null };
    render();

    // The shared body renderer is used (pixel-identical to the Changes panel).
    expect(container?.querySelector('[data-testid="diff-file-body"]')).not.toBeNull();
    // The real ParsedDiffFile is forwarded along with the resolved layout/wrap/font props.
    expect(lastDiffFileBodyProps.value?.file).toBe(file);
    expect(lastDiffFileBodyProps.value?.layout).toBe("unified");
    expect(lastDiffFileBodyProps.value?.wrapLines).toBe(false);
    expect(lastDiffFileBodyProps.value?.codeFontSize).toBe(12);
    // The per-commit view has no inline-review affordances.
    expect(lastDiffFileBodyProps.value?.reviewActions).toBeUndefined();
  });

  it("shows the loading spinner while loading", () => {
    commitFileDiff.value = { file: null, isLoading: true, error: null };
    render();

    expect(container?.querySelector('[data-icon="spinner"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });

  it("shows the empty message when there is no file", () => {
    commitFileDiff.value = { file: null, isLoading: false, error: null };
    render();

    expect(container?.textContent).toContain("workspace.git.diff.commits.fileDiffEmpty");
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });

  it("shows the error message on error", () => {
    commitFileDiff.value = { file: null, isLoading: false, error: new Error("boom") };
    render();

    expect(container?.textContent).toContain("workspace.git.diff.commits.fileDiffError");
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });
});
