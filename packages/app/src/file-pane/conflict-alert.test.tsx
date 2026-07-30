/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500" },
    colors: {
      surface1: "#111",
      foregroundMuted: "#aaa",
      palette: { amber: { 500: "#f59e0b" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (value: typeof theme) => unknown)(theme)
        : factory,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => Component,
}));

vi.mock("lucide-react-native", () => ({
  AlertTriangle: () => React.createElement("span", { "data-testid": "warning-icon" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "panels.file.editor.changedOnDisk": "Changed on disk",
        "panels.file.editor.deletedTitle": "File deleted on disk",
        "panels.file.editor.checkFailedTitle": "Couldn't check file on disk",
        "panels.file.editor.preservedDescription": "The open copy is preserved.",
        "panels.file.editor.conflictDescription":
          "The local buffer was preserved. Choose which version to keep.",
        "panels.file.editor.overwrite": "Overwrite",
        "panels.file.editor.reload": "Reload",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress(): void }) =>
    React.createElement("button", { type: "button", onClick: onPress }, children),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { FileConflictAlert } from "./conflict-alert";

describe("FileConflictAlert", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function render(fileStatus: "ready" | "missing" | "error", modified: boolean) {
    act(() => {
      root?.render(
        <FileConflictAlert
          fileStatus={fileStatus}
          modified={modified}
          onOverwrite={vi.fn()}
          onReload={vi.fn()}
        />,
      );
    });
  }

  it("offers only reload when an unmodified file changed on disk", () => {
    render("ready", false);

    expect(container?.textContent).toContain("Changed on disk");
    expect(container?.textContent).toContain("Reload");
    expect(container?.textContent).not.toContain("Overwrite");
  });

  it("offers overwrite and reload when a modified file changed on disk", () => {
    render("ready", true);

    expect(container?.textContent).toContain("Changed on disk");
    expect(container?.textContent).toContain("Overwrite");
    expect(container?.textContent).toContain("Reload");
  });

  it("reports a deleted file without offering unavailable actions", () => {
    render("missing", false);

    expect(container?.textContent).toContain("File deleted on disk");
    expect(container?.textContent).toContain("The open copy is preserved.");
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });

  it("does not report a file check error as a deletion", () => {
    render("error", false);

    expect(container?.textContent).toContain("Couldn't check file on disk");
    expect(container?.textContent).not.toContain("File deleted on disk");
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });
});
