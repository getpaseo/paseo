/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500", semibold: "600" },
    colors: {
      surface0: "#000",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f44",
    },
  },
}));

const asyncStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => asyncStorage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    asyncStorage.values.set(key, value);
  }),
}));

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const activeSelection = vi.hoisted(() => ({
  value: { serverId: "server-1", workspaceId: "workspace-1" } as {
    serverId: string;
    workspaceId: string;
  } | null,
}));

const activeWorkspace = vi.hoisted(() => ({
  value: {
    id: "workspace-1",
    projectId: "project-1",
    projectKind: "git",
    projectRootPath: "/repo/project-1",
    project: { checkout: { mainRepoRoot: "/repo/project-1" } },
  } as Record<string, unknown> | null,
}));

const client = vi.hoisted(() => ({
  readProjectConfig: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorage,
}));

vi.mock("expo-router", () => ({
  useRouter: () => router,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useNavigationActiveWorkspaceSelection: () => activeSelection.value,
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceFields: (
    serverId: string | null,
    workspaceId: string | null,
    project: (workspace: Record<string, unknown>) => unknown,
  ) => {
    if (
      !activeWorkspace.value ||
      serverId !== activeSelection.value?.serverId ||
      workspaceId !== activeWorkspace.value.id
    ) {
      return null;
    }
    return project(activeWorkspace.value);
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => (serverId === "server-1" ? client : null),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const X = (props: Record<string, unknown>) => React.createElement("span", props);
  return { X };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { WorktreeSetupCalloutSource } from "./worktree-setup-callout-source";

function readOk(config: Record<string, unknown>) {
  return {
    ok: true,
    config,
    revision: { exists: true, mtimeMs: 1, size: 2 },
  };
}

function readError() {
  return {
    ok: false,
    error: { code: "project_not_found", message: "Project not found" },
  };
}

function Harness({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SidebarCalloutProvider>
        <WorktreeSetupCalloutSource />
        <SidebarCalloutSlot />
      </SidebarCalloutProvider>
    </QueryClientProvider>
  );
}

async function renderHarness(root: Root, queryClient: QueryClient): Promise<void> {
  await act(async () => {
    root.render(<Harness queryClient={queryClient} />);
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function findByTestId(testID: string): Promise<HTMLElement | null> {
  let element: HTMLElement | null = null;
  for (let index = 0; index < 10 && !element; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    element = document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  }
  return element;
}

describe("WorktreeSetupCalloutSource", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    activeSelection.value = { serverId: "server-1", workspaceId: "workspace-1" };
    activeWorkspace.value = {
      id: "workspace-1",
      projectId: "project-1",
      projectKind: "git",
      projectRootPath: "/repo/project-1",
      project: { checkout: { mainRepoRoot: "/repo/project-1" } },
    };
    client.readProjectConfig.mockReset();
    client.readProjectConfig.mockResolvedValue(readOk({}));
    router.navigate.mockClear();
    asyncStorage.values.clear();
    asyncStorage.getItem.mockClear();
    asyncStorage.setItem.mockClear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
    }
    queryClient?.clear();
    queryClient = null;
    root = null;
    container?.remove();
    container = null;
  });

  it("registers a callout for an active git workspace with missing setup", async () => {
    await renderHarness(root!, queryClient!);

    expect(await findByTestId("worktree-setup-callout-project-1")).not.toBeNull();
    expect(container?.textContent).toContain("Set up worktree scripts");
    expect(container?.textContent).toContain("Open project settings");
    expect(client.readProjectConfig).toHaveBeenCalledWith("/repo/project-1");
  });

  it("does not register a callout for a non-git workspace", async () => {
    activeWorkspace.value = {
      id: "workspace-1",
      projectId: "project-1",
      projectKind: "local",
      projectRootPath: "/repo/project-1",
    };

    await renderHarness(root!, queryClient!);

    expect(container?.querySelector('[data-testid="worktree-setup-callout-project-1"]')).toBeNull();
    expect(client.readProjectConfig).not.toHaveBeenCalled();
  });

  it("does not register a callout when setup is present", async () => {
    client.readProjectConfig.mockResolvedValue(readOk({ worktree: { setup: "npm install" } }));

    await renderHarness(root!, queryClient!);

    expect(container?.querySelector('[data-testid="worktree-setup-callout-project-1"]')).toBeNull();
  });

  it("does not register a callout without an active workspace", async () => {
    activeSelection.value = null;

    await renderHarness(root!, queryClient!);

    expect(container?.querySelector('[data-testid="worktree-setup-callout-project-1"]')).toBeNull();
    expect(client.readProjectConfig).not.toHaveBeenCalled();
  });

  it("does not register a callout when reading paseo.json fails", async () => {
    client.readProjectConfig.mockResolvedValue(readError());

    await renderHarness(root!, queryClient!);

    expect(container?.querySelector('[data-testid="worktree-setup-callout-project-1"]')).toBeNull();
  });

  it("opens project settings from the callout action", async () => {
    await renderHarness(root!, queryClient!);

    const action = await findByTestId("worktree-setup-callout-project-1-action-0");
    expect(action).not.toBeNull();

    act(() => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(router.navigate).toHaveBeenCalledWith("/settings/projects/project-1");
  });

  it("persists dismissal for the project", async () => {
    await renderHarness(root!, queryClient!);

    const dismiss = await findByTestId("worktree-setup-callout-project-1-dismiss");
    expect(dismiss).not.toBeNull();

    act(() => {
      dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      "@paseo:sidebar-callout-dismissals",
      JSON.stringify(["worktree-setup-missing:project-1"]),
    );
    expect(container?.querySelector('[data-testid="worktree-setup-callout-project-1"]')).toBeNull();
  });
});
