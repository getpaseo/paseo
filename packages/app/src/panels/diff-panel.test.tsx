import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { DiffFilesResult } from "@/git/use-diff-files";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 16: 64 },
    fontSize: { xs: 11, sm: 13, base: 14, code: 12 },
    fontWeight: { normal: "400" },
    borderRadius: { md: 6 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      destructive: "#f00",
      surface0: "#000",
      surface1: "#111",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
    },
  },
}));

// Mocked so the suite exercises DiffPanel's own state branching + section
// assembly without pulling in the real diff renderer (its own test covers it),
// FlatList virtualization, or the data hooks.
const { diffFilesResult } = vi.hoisted(() => ({
  diffFilesResult: { value: null as DiffFilesResult | null },
}));

const { paneContext } = vi.hoisted(() => ({
  paneContext: {
    value: {
      serverId: "server-1",
      workspaceId: "ws-1",
      target: {
        kind: "diff" as const,
        diffTarget: { kind: "working" as const, mode: "uncommitted" as const },
        focusPath: undefined as string | undefined,
      },
    },
  },
}));

const { workspaceDirectory } = vi.hoisted(() => ({
  workspaceDirectory: { value: "/tmp/repo" as string | null },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web", select: (specifics: Record<string, unknown>) => specifics.default },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  ActivityIndicator: () => React.createElement("div", { "data-testid": "activity-indicator" }),
  // Minimal FlatList: render every item so we can assert the section list content.
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    testID,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      data.map((item) =>
        React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item })),
      ),
    ),
}));

vi.mock("react-native-svg", () => ({
  SvgXml: () => React.createElement("svg", { "data-testid": "file-icon" }),
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

vi.mock("lucide-react-native", () => ({
  GitCommitHorizontal: () => React.createElement("span", { "data-icon": "commit" }),
}));

vi.mock("@/components/diff-stat", () => ({
  DiffStat: ({ additions, deletions }: { additions: number; deletions: number }) =>
    React.createElement("span", { "data-testid": "diff-stat" }, `+${additions} -${deletions}`),
}));

vi.mock("@/components/material-file-icons", () => ({
  getFileIconSvg: () => "<svg/>",
}));

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));

vi.mock("@/git/diff-file-body", () => ({
  DiffFileBody: ({ file }: { file: { path: string } }) =>
    React.createElement("div", { "data-testid": "diff-file-body" }, file.path),
}));

vi.mock("@/git/use-diff-files", () => ({
  useDiffFiles: () => diffFilesResult.value,
}));

vi.mock("@/hooks/use-changes-preferences", () => ({
  useChangesPreferences: () => ({
    preferences: { wrapLines: false, layout: "unified", fileView: "list", hideWhitespace: false },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { codeFontSize: 12, monoFontFamily: "Fira Code" } }),
}));

vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => paneContext.value,
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => workspaceDirectory.value,
}));

vi.mock("@/utils/diff-layout", () => ({
  buildSplitDiffRows: () => [],
}));

import { diffPanelRegistration } from "./diff-panel";

const DiffPanel = diffPanelRegistration.component;

function makeFile(path: string, overrides: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return {
    path,
    isNew: overrides.isNew ?? false,
    isDeleted: overrides.isDeleted ?? false,
    additions: overrides.additions ?? 2,
    deletions: overrides.deletions ?? 1,
    status: overrides.status,
    hunks: overrides.hunks ?? [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: "x", tokens: [] }],
      },
    ],
  } as unknown as ParsedDiffFile;
}

function result(overrides: Partial<DiffFilesResult> = {}): DiffFilesResult {
  return {
    files: overrides.files ?? [],
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
    capabilityMissing: overrides.capabilityMissing,
  };
}

describe("DiffPanel", () => {
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

    workspaceDirectory.value = "/tmp/repo";
    paneContext.value.target.focusPath = undefined;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container = null;
    diffFilesResult.value = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(React.createElement(DiffPanel));
    });
  }

  it("renders a header + DiffFileBody section for each changed file", () => {
    diffFilesResult.value = result({
      files: [makeFile("a.ts"), makeFile("src/b.ts")],
    });
    render();

    const bodies = container?.querySelectorAll('[data-testid="diff-file-body"]');
    expect(bodies?.length).toBe(2);
    expect(bodies?.[0]?.textContent).toBe("a.ts");
    expect(bodies?.[1]?.textContent).toBe("src/b.ts");
    // Each file section carries its filename header, icon, and diff stat.
    expect(container?.querySelectorAll('[data-testid="file-icon"]').length).toBe(2);
    expect(container?.querySelectorAll('[data-testid="diff-stat"]').length).toBe(2);
    expect(container?.textContent).toContain("a.ts");
    expect(container?.textContent).toContain("src/b.ts");
  });

  it("shows a spinner while loading with no files yet", () => {
    diffFilesResult.value = result({ isLoading: true });
    render();

    expect(container?.querySelector('[data-testid="diff-panel-loading"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });

  it("shows the empty state when there are no changes", () => {
    diffFilesResult.value = result({ files: [] });
    render();

    expect(container?.querySelector('[data-testid="diff-panel-empty"]')).not.toBeNull();
    expect(container?.textContent).toContain("panels.diff.empty");
  });

  it("shows the capability-missing notice for a commit diff on an old host", () => {
    diffFilesResult.value = result({ capabilityMissing: true });
    render();

    expect(
      container?.querySelector('[data-testid="diff-panel-capability-missing"]'),
    ).not.toBeNull();
    expect(container?.textContent).toContain("panels.diff.capabilityMissing");
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });

  it("surfaces a load error", () => {
    diffFilesResult.value = result({ error: new Error("boom") });
    render();

    expect(container?.querySelector('[data-testid="diff-panel-error"]')).not.toBeNull();
    expect(container?.textContent).toContain("boom");
  });

  it("falls back to a directory-missing message when the workspace dir is unresolved", () => {
    workspaceDirectory.value = null;
    diffFilesResult.value = result({ files: [makeFile("a.ts")] });
    render();

    expect(container?.textContent).toContain("panels.diff.directoryMissing");
    expect(container?.querySelector('[data-testid="diff-file-body"]')).toBeNull();
  });
});
