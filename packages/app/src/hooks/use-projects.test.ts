/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptorPayload } from "@server/shared/messages";
import { useProjects } from "./use-projects";

interface MockDaemonClient {
  fetchWorkspaces: ReturnType<typeof vi.fn>;
}

const { hostState, clientsByServerId, runtimeStore } = vi.hoisted(() => {
  const state = {
    hosts: [
      { serverId: "local", label: "Local" },
      { serverId: "laptop", label: "Laptop" },
    ],
    snapshots: new Map<string, { connectionStatus: string }>(),
  };
  const clients = new Map<string, { fetchWorkspaces: ReturnType<typeof vi.fn> }>();
  return {
    hostState: state,
    clientsByServerId: clients,
    runtimeStore: {
      getClient: (serverId: string) => clients.get(serverId) ?? null,
      getSnapshot: (serverId: string) => state.snapshots.get(serverId) ?? null,
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtimeStore,
  useHosts: () => hostState.hosts,
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function renderProjectsHook() {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useProjects(), { wrapper });
}

function makeClient(entries: WorkspaceDescriptorPayload[] | Error): MockDaemonClient {
  return {
    fetchWorkspaces: vi.fn(async () => {
      if (entries instanceof Error) {
        throw entries;
      }
      return {
        requestId: "req-workspaces",
        entries,
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      };
    }),
  };
}

function workspace(input: {
  id: string;
  projectKey: string;
  projectName: string;
  cwd: string;
  remoteUrl: string | null;
}): WorkspaceDescriptorPayload {
  return {
    id: input.id,
    projectId: input.projectKey,
    projectDisplayName: input.projectName,
    projectRootPath: input.cwd,
    workspaceDirectory: input.cwd,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.id,
    archivingAt: null,
    status: "done",
    activityAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: {
      currentBranch: "main",
      remoteUrl: input.remoteUrl,
      isPaseoOwnedWorktree: false,
      isDirty: false,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
    },
    githubRuntime: null,
    project: {
      projectKey: input.projectKey,
      projectName: input.projectName,
      checkout: {
        cwd: input.cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: input.remoteUrl,
        worktreeRoot: input.cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

afterEach(() => {
  clientsByServerId.clear();
  hostState.hosts = [
    { serverId: "local", label: "Local" },
    { serverId: "laptop", label: "Laptop" },
  ];
  hostState.snapshots = new Map<string, { connectionStatus: string }>();
});

describe("useProjects", () => {
  it("calls all known daemon clients and returns aggregated projects sorted by display name", async () => {
    hostState.snapshots.set("local", { connectionStatus: "online" });
    hostState.snapshots.set("laptop", { connectionStatus: "online" });
    clientsByServerId.set(
      "local",
      makeClient([
        workspace({
          id: "z-main",
          projectKey: "remote:github.com/acme/zeta",
          projectName: "acme/zeta",
          cwd: "/repo/zeta",
          remoteUrl: "https://github.com/acme/zeta.git",
        }),
      ]),
    );
    clientsByServerId.set(
      "laptop",
      makeClient([
        workspace({
          id: "a-main",
          projectKey: "remote:github.com/acme/alpha",
          projectName: "acme/alpha",
          cwd: "/repo/alpha",
          remoteUrl: "https://github.com/acme/alpha.git",
        }),
      ]),
    );

    const { result } = renderProjectsHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(clientsByServerId.get("local")?.fetchWorkspaces).toHaveBeenCalledTimes(1);
    expect(clientsByServerId.get("laptop")?.fetchWorkspaces).toHaveBeenCalledTimes(1);
    expect(result.current.projects.map((project) => project.projectName)).toEqual([
      "acme/alpha",
      "acme/zeta",
    ]);
  });

  it("surfaces per-host fetch failures without dropping successful hosts", async () => {
    hostState.snapshots.set("local", { connectionStatus: "online" });
    hostState.snapshots.set("laptop", { connectionStatus: "online" });
    clientsByServerId.set(
      "local",
      makeClient([
        workspace({
          id: "main",
          projectKey: "remote:github.com/acme/app",
          projectName: "acme/app",
          cwd: "/repo/app",
          remoteUrl: "https://github.com/acme/app.git",
        }),
      ]),
    );
    clientsByServerId.set("laptop", makeClient(new Error("laptop unavailable")));

    const { result } = renderProjectsHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.projects).toEqual([
      expect.objectContaining({ projectKey: "remote:github.com/acme/app" }),
    ]);
    expect(result.current.hostErrors).toEqual([
      {
        serverId: "laptop",
        serverName: "Laptop",
        message: "laptop unavailable",
      },
    ]);
  });

  it("skips disconnected hosts silently without surfacing them as failures", async () => {
    hostState.snapshots.set("local", { connectionStatus: "online" });
    hostState.snapshots.set("laptop", { connectionStatus: "offline" });
    clientsByServerId.set(
      "local",
      makeClient([
        workspace({
          id: "main",
          projectKey: "remote:github.com/acme/app",
          projectName: "acme/app",
          cwd: "/repo/app",
          remoteUrl: "https://github.com/acme/app.git",
        }),
      ]),
    );

    const { result } = renderProjectsHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.hostErrors).toEqual([]);
    expect(result.current.projects).toEqual([
      expect.objectContaining({ projectKey: "remote:github.com/acme/app" }),
    ]);
  });

  it("returns only the stable public project and host entry shapes", async () => {
    hostState.snapshots.set("local", { connectionStatus: "online" });
    clientsByServerId.set(
      "local",
      makeClient([
        workspace({
          id: "main",
          projectKey: "remote:github.com/acme/app",
          projectName: "acme/app",
          cwd: "/repo/app",
          remoteUrl: "https://github.com/acme/app.git",
        }),
      ]),
    );

    const { result } = renderProjectsHook();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(Object.keys(result.current.projects[0] ?? {}).sort()).toEqual([
      "githubUrl",
      "hiddenUnsupportedRemoteCount",
      "hostCount",
      "hosts",
      "onlineHostCount",
      "projectKey",
      "projectName",
      "totalWorkspaceCount",
    ]);
    expect(Object.keys(result.current.projects[0]?.hosts[0] ?? {}).sort()).toEqual([
      "gitRuntime",
      "githubRuntime",
      "isOnline",
      "repoRoot",
      "serverId",
      "serverName",
      "workspaceCount",
      "workspaces",
    ]);
    expect(Object.keys(result.current.projects[0]?.hosts[0]?.workspaces[0] ?? {}).sort()).toEqual([
      "currentBranch",
      "id",
      "name",
      "status",
      "workspaceKind",
    ]);
  });
});
