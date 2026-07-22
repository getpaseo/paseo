/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

const { theme } = vi.hoisted(() => ({
  theme: {
    colorScheme: "dark",
    iconSize: { sm: 14, md: 18 },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    colors: {
      surface0: "#000",
      surfaceSidebar: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      palette: {
        amber: { 500: "#f59e0b", 700: "#b45309" },
        red: { 500: "#ef4444" },
        blue: { 500: "#3b82f6" },
        green: { 500: "#22c55e" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
    function Themed({ uniProps, ...rest }: Record<string, unknown>) {
      const mapped = typeof uniProps === "function" ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...(mapped as object) });
    },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
    CircleAlert: createIcon("CircleAlert"),
  };
});

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-loader": "synced" }),
}));

vi.mock("@/components/project-icon-view", () => ({
  ProjectIconView: ({ initial }: { initial: string }) =>
    React.createElement("span", { "data-project-icon": initial }, initial),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ProjectLeadingVisual } from "./project-leading-visual";

describe("ProjectLeadingVisual", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(props: {
    statusBucket: SidebarStateBucket | null;
    showChevron?: boolean;
    isArchiving?: boolean;
  }): void {
    act(() => {
      root.render(
        <ProjectLeadingVisual
          displayName="kaspesi/onthegrid_harness"
          iconDataUri={null}
          projectKey="project-a"
          chevron="expand"
          showChevron={props.showChevron ?? false}
          isArchiving={props.isArchiving ?? false}
          statusBucket={props.statusBucket}
        />,
      );
    });
  }

  function indicator(bucket: string): Element | null {
    return container.querySelector(`[data-testid="project-status-indicator-${bucket}"]`);
  }

  function statusDot(): Element | null {
    return container.querySelector('[data-testid="project-status-dot"]');
  }

  function glyphBadge(): Element | null {
    return container.querySelector('[data-testid="project-status-badge"]');
  }

  function projectIcon(): Element | null {
    return container.querySelector("[data-project-icon]");
  }

  it("shows only the project icon when nothing is happening", () => {
    render({ statusBucket: "done" });
    expect(projectIcon()).not.toBeNull();
    expect(statusDot()).toBeNull();
    expect(glyphBadge()).toBeNull();
  });

  it("shows only the project icon when the project is expanded (no aggregate)", () => {
    render({ statusBucket: null });
    expect(projectIcon()).not.toBeNull();
    expect(statusDot()).toBeNull();
    expect(glyphBadge()).toBeNull();
  });

  it("keeps the project icon and badges it with the loader when running", () => {
    render({ statusBucket: "running" });
    expect(indicator("running")).not.toBeNull();
    // The lettered project icon must survive — it's what marks the row as a project.
    expect(projectIcon()).not.toBeNull();
    expect(glyphBadge()).not.toBeNull();
    expect(container.querySelector('[data-loader="synced"]')).not.toBeNull();
  });

  it("keeps the project icon and badges it with the alert when needs input", () => {
    render({ statusBucket: "needs_input" });
    expect(indicator("needs_input")).not.toBeNull();
    expect(projectIcon()).not.toBeNull();
    expect(glyphBadge()).not.toBeNull();
    expect(container.querySelector('[data-icon="CircleAlert"]')).not.toBeNull();
  });

  it("badges the project icon with a dot when a workspace is ready to review", () => {
    render({ statusBucket: "attention" });
    expect(indicator("attention")).not.toBeNull();
    expect(projectIcon()).not.toBeNull();
    expect(statusDot()).not.toBeNull();
    // The dot rides inside the same shell as the loader and alert, not a bare corner dot.
    expect(glyphBadge()).not.toBeNull();
    expect(glyphBadge()?.contains(statusDot() as Node)).toBe(true);
  });

  it("badges the project icon with a dot when a workspace failed", () => {
    render({ statusBucket: "failed" });
    expect(indicator("failed")).not.toBeNull();
    expect(projectIcon()).not.toBeNull();
    expect(statusDot()).not.toBeNull();
    expect(glyphBadge()).not.toBeNull();
    expect(glyphBadge()?.contains(statusDot() as Node)).toBe(true);
  });

  it("gives every surfaced status the identical badge shell", () => {
    const shells = (["running", "needs_input", "attention", "failed"] as const).map((bucket) => {
      render({ statusBucket: bucket });
      const shell = glyphBadge();
      expect(shell).not.toBeNull();
      // react-native-web flattens the style object onto the DOM node, so the rendered
      // geometry is directly comparable across buckets.
      const { width, height, right, bottom, borderRadius, borderWidth } = (shell as HTMLElement)
        .style;
      return { width, height, right, bottom, borderRadius, borderWidth };
    });

    expect(shells[0].width).not.toBe("");
    for (const shell of shells.slice(1)) {
      expect(shell).toEqual(shells[0]);
    }
  });

  it("hands the slot to the chevron on hover, hiding the status", () => {
    render({ statusBucket: "running", showChevron: true });
    expect(indicator("running")).toBeNull();
    expect(container.querySelector('[data-icon="ChevronRight"]')).not.toBeNull();
  });

  it("shows the archive spinner instead of the status while removing the project", () => {
    render({ statusBucket: "running", isArchiving: true });
    expect(indicator("archiving")).not.toBeNull();
    expect(indicator("running")).toBeNull();
  });
});
