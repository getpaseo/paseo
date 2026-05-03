/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectHostEntry, ProjectSummary, WorkspaceSummary } from "@/utils/projects";
import type { ProjectHostError, UseProjectsResult } from "@/hooks/use-projects";

const { theme, projectsState, navigate } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" as const, medium: "500" as const },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    opacity: { 50: 0.5 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      surfaceSidebarHover: "#1a1a1a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#444",
      accent: "#0a84ff",
      palette: { red: { 300: "#ff6b6b" } },
    },
  },
  projectsState: {
    current: {
      projects: [],
      hostErrors: [],
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as UseProjectsResult,
  },
  navigate: vi.fn(),
}));

vi.mock("react-native", () => {
  const passthrough = ({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
    onPress,
    onHoverIn,
    onHoverOut,
    ...rest
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    onPress?: (event: { stopPropagation: () => void }) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
  } & Record<string, unknown>) => {
    const dataAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-")) {
        dataAttrs[key] = value;
      }
    }
    return React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onClick: onPress
          ? (event: React.MouseEvent) => {
              onPress({ stopPropagation: () => event.stopPropagation() });
            }
          : undefined,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
        ...dataAttrs,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    );
  };

  return {
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("span", null, children),
    Pressable: passthrough,
    Image: ({ source }: { source?: { uri?: string } }) =>
      React.createElement("img", { src: source?.uri ?? "" }),
    Platform: { OS: "web" },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    ChevronRight: icon("ChevronRight"),
    MoreVertical: icon("MoreVertical"),
    ExternalLink: icon("ExternalLink"),
    Pencil: icon("Pencil"),
    FolderGit2: icon("FolderGit2"),
  };
});

vi.mock("expo-router", () => ({
  router: { navigate },
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: ({ size }: { size?: string | number }) =>
    React.createElement("span", {
      "data-testid": "projects-loading-spinner",
      "data-size": size,
    }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuTrigger: ({
    children,
    accessibilityLabel,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean; open: boolean }) => React.ReactNode);
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      typeof children === "function"
        ? children({ pressed: false, hovered: false, open: false })
        : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu-content" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onSelect?.();
        },
      },
      children,
    ),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => projectsState.current,
}));

vi.mock("@/hooks/use-project-icon-query", () => ({
  useProjectIconQuery: () => ({ icon: null, isLoading: false, isError: false }),
}));

import ProjectsScreen from "./projects-screen";

function workspaceSummary(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-1",
    name: "main",
    workspaceKind: "directory",
    status: "done",
    currentBranch: "main",
    ...overrides,
  };
}

function hostEntry(overrides: Partial<ProjectHostEntry> = {}): ProjectHostEntry {
  return {
    serverId: "host-a",
    serverName: "alpha",
    isOnline: true,
    repoRoot: "/home/me/proj",
    workspaceCount: 1,
    workspaces: [workspaceSummary()],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const hosts = overrides.hosts ?? [hostEntry()];
  const totalWorkspaceCount =
    overrides.totalWorkspaceCount ?? hosts.reduce((sum, host) => sum + host.workspaceCount, 0);
  const onlineHostCount = overrides.onlineHostCount ?? hosts.filter((h) => h.isOnline).length;
  return {
    projectKey: "remote:github.com/acme/app",
    projectName: "acme/app",
    hosts,
    totalWorkspaceCount,
    hostCount: hosts.length,
    onlineHostCount,
    githubUrl: "https://github.com/acme/app",
    ...overrides,
  };
}

function setProjectsState(overrides: Partial<UseProjectsResult>) {
  projectsState.current = {
    projects: [],
    hostErrors: [],
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function findRow(container: HTMLElement, projectKey: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-testid="project-row-${projectKey}"]`);
  if (!row) throw new Error(`Expected row for ${projectKey}`);
  return row;
}

describe("ProjectsScreen", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setProjectsState({});
    navigate.mockReset();
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
    vi.unstubAllGlobals();
  });

  function render(view: { kind: "projects" } | { kind: "project"; projectKey: string }) {
    act(() => {
      root?.render(<ProjectsScreen view={view} />);
    });
  }

  it("renders a row whose visible content is the project name only", () => {
    setProjectsState({
      projects: [
        project({
          projectName: "acme/app",
          hosts: [hostEntry({ serverName: "alpha", workspaceCount: 5 })],
        }),
      ],
    });

    render({ kind: "projects" });

    const rows = container?.querySelectorAll('[data-testid^="project-row-"]') ?? [];
    expect(rows.length).toBe(1);
    expect(container?.textContent).toContain("acme/app");
    expect(container?.textContent).not.toContain("workspace");
    expect(container?.textContent).not.toContain("offline");
    expect(container?.textContent).not.toContain("github.com");
  });

  it("navigates to the project detail route when the row is pressed", () => {
    setProjectsState({
      projects: [project({ projectKey: "remote:github.com/acme/app" })],
    });

    render({ kind: "projects" });

    const row = findRow(container!, "remote:github.com/acme/app");
    act(() => {
      row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/settings/projects/remote%3Agithub.com%2Facme%2Fapp");
  });

  it("does not render a kebab menu on the row", () => {
    setProjectsState({
      projects: [project({ projectKey: "remote:github.com/acme/app" })],
    });

    render({ kind: "projects" });

    expect(
      container?.querySelector('[data-testid="project-row-menu-remote:github.com/acme/app"]'),
    ).toBeNull();
  });

  it("renders a centered loading spinner before the first response", () => {
    setProjectsState({ isLoading: true, projects: [] });

    render({ kind: "projects" });

    expect(container?.querySelector('[data-testid="projects-loading-spinner"]')).not.toBeNull();
  });

  it("renders the empty state when there are no projects", () => {
    setProjectsState({ projects: [] });

    render({ kind: "projects" });

    expect(container?.textContent).toContain("No projects yet");
    expect(container?.textContent).not.toContain("Non-GitHub remote projects aren't supported yet");
  });

  it("renders a partial-host-failure banner above the list, naming each failed host", () => {
    const hostErrors: ProjectHostError[] = [
      { serverId: "a", serverName: "alpha", message: "timed out" },
      { serverId: "b", serverName: "beta", message: "unreachable" },
    ];
    setProjectsState({
      projects: [project()],
      hostErrors,
    });

    render({ kind: "projects" });

    const banner = container?.querySelector('[data-testid="projects-host-errors"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("alpha");
    expect(banner?.textContent).toContain("beta");
    expect(container?.querySelector('[data-testid^="project-row-"]')).not.toBeNull();
  });

  it("highlights the selected row when the active view targets a project", () => {
    setProjectsState({
      projects: [
        project({ projectKey: "remote:github.com/acme/app" }),
        project({
          projectKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          githubUrl: "https://github.com/acme/other",
        }),
      ],
    });

    render({ kind: "project", projectKey: "remote:github.com/acme/app" });

    const selected = findRow(container!, "remote:github.com/acme/app");
    const other = findRow(container!, "remote:github.com/acme/other");
    expect(selected.getAttribute("data-selected")).toBe("true");
    expect(other.getAttribute("data-selected")).toBe("false");
  });

  it("does not include the word 'checkout' anywhere in the rendered tree", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", workspaceCount: 3 }),
            hostEntry({ serverId: "b", serverName: "beta", workspaceCount: 2 }),
          ],
        }),
      ],
      hostErrors: [{ serverId: "x", serverName: "x", message: "down" }],
    });

    render({ kind: "projects" });

    const html = container?.innerHTML.toLowerCase() ?? "";
    expect(html).not.toContain("checkout");
  });
});
