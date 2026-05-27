import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  fetchAggregatedProjects,
  type ProjectsHostInput,
  type ProjectsRuntime,
  type ProjectsRuntimeSnapshot,
} from "./use-projects";

type FetchWorkspaces = DaemonClient["fetchWorkspaces"];
type FetchWorkspacesResult = Awaited<ReturnType<FetchWorkspaces>>;

interface HostFixture {
  serverId: string;
  serverName: string;
  status: "online" | "offline" | "missing-snapshot";
  workspaces?: WorkspaceDescriptorPayload[] | Error;
}

interface RuntimeAdapter extends ProjectsRuntime {
  fetchCalls: Map<string, number>;
}

function createRuntime(hosts: HostFixture[]): RuntimeAdapter {
  const snapshots = new Map<string, ProjectsRuntimeSnapshot | null>();
  const clients = new Map<string, Pick<DaemonClient, "fetchWorkspaces"> | null>();
  const fetchCalls = new Map<string, number>();

  for (const host of hosts) {
    if (host.status === "missing-snapshot") {
      snapshots.set(host.serverId, null);
    } else {
      snapshots.set(host.serverId, { connectionStatus: host.status });
    }

    if (host.workspaces === undefined) {
      clients.set(host.serverId, null);
      continue;
    }

    const workspaces = host.workspaces;
    const fetchWorkspaces: FetchWorkspaces = async () => {
      fetchCalls.set(host.serverId, (fetchCalls.get(host.serverId) ?? 0) + 1);
      if (workspaces instanceof Error) {
        throw workspaces;
      }
      return {
        requestId: `req-${host.serverId}`,
        entries: workspaces,
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      } satisfies FetchWorkspacesResult;
    };

    clients.set(host.serverId, { fetchWorkspaces });
  }

  return {
    getClient: (serverId) => clients.get(serverId) ?? null,
    getSnapshot: (serverId) => snapshots.get(serverId),
    fetchCalls,
  };
}

function hostInputs(hosts: HostFixture[]): ProjectsHostInput[] {
  return hosts.map((host) => ({ serverId: host.serverId, serverName: host.serverName }));
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

describe("fetchAggregatedProjects", () => {
  it("calls every online host's client and aggregates projects sorted by display name", async () => {
    const hosts: HostFixture[] = [
      {
        serverId: "local",
        serverName: "Local",
        status: "online",
        workspaces: [
          workspace({
            id: "z-main",
            projectKey: "remote:github.com/acme/zeta",
            projectName: "acme/zeta",
            cwd: "/repo/zeta",
            remoteUrl: "https://github.com/acme/zeta.git",
          }),
        ],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        status: "online",
        workspaces: [
          workspace({
            id: "a-main",
            projectKey: "remote:github.com/acme/alpha",
            projectName: "acme/alpha",
            cwd: "/repo/alpha",
            remoteUrl: "https://github.com/acme/alpha.git",
          }),
        ],
      },
    ];
    const runtime = createRuntime(hosts);

    const result = await fetchAggregatedProjects({ hosts: hostInputs(hosts), runtime });

    expect(runtime.fetchCalls.get("local")).toBe(1);
    expect(runtime.fetchCalls.get("laptop")).toBe(1);
    expect(result.projects.map((project) => project.projectName)).toEqual([
      "acme/alpha",
      "acme/zeta",
    ]);
    expect(result.hostErrors).toEqual([]);
  });

  it("surfaces per-host fetch failures without dropping successful hosts", async () => {
    const hosts: HostFixture[] = [
      {
        serverId: "local",
        serverName: "Local",
        status: "online",
        workspaces: [
          workspace({
            id: "main",
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            cwd: "/repo/app",
            remoteUrl: "https://github.com/acme/app.git",
          }),
        ],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        status: "online",
        workspaces: new Error("laptop unavailable"),
      },
    ];
    const runtime = createRuntime(hosts);

    const result = await fetchAggregatedProjects({ hosts: hostInputs(hosts), runtime });

    expect(result.projects).toEqual([
      expect.objectContaining({ projectKey: "remote:github.com/acme/app" }),
    ]);
    expect(result.hostErrors).toEqual([
      {
        serverId: "laptop",
        serverName: "Laptop",
        message: "laptop unavailable",
      },
    ]);
  });

  it("skips disconnected hosts silently without surfacing them as failures", async () => {
    const hosts: HostFixture[] = [
      {
        serverId: "local",
        serverName: "Local",
        status: "online",
        workspaces: [
          workspace({
            id: "main",
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            cwd: "/repo/app",
            remoteUrl: "https://github.com/acme/app.git",
          }),
        ],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        status: "offline",
      },
    ];
    const runtime = createRuntime(hosts);

    const result = await fetchAggregatedProjects({ hosts: hostInputs(hosts), runtime });

    expect(result.hostErrors).toEqual([]);
    expect(result.projects).toEqual([
      expect.objectContaining({ projectKey: "remote:github.com/acme/app" }),
    ]);
    expect(runtime.fetchCalls.get("laptop")).toBeUndefined();
  });

  it("returns only the stable public project and host entry shapes", async () => {
    const hosts: HostFixture[] = [
      {
        serverId: "local",
        serverName: "Local",
        status: "online",
        workspaces: [
          workspace({
            id: "main",
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            cwd: "/repo/app",
            remoteUrl: "https://github.com/acme/app.git",
          }),
        ],
      },
    ];
    const runtime = createRuntime(hosts);

    const result = await fetchAggregatedProjects({ hosts: hostInputs(hosts), runtime });

    expect(Object.keys(result.projects[0] ?? {}).sort()).toEqual([
      "githubUrl",
      "hostCount",
      "hosts",
      "onlineHostCount",
      "projectCustomName",
      "projectKey",
      "projectName",
      "totalWorkspaceCount",
    ]);
    expect(Object.keys(result.projects[0]?.hosts[0] ?? {}).sort()).toEqual([
      "gitRuntime",
      "githubRuntime",
      "isOnline",
      "repoRoot",
      "serverId",
      "serverName",
      "workspaceCount",
      "workspaces",
    ]);
    expect(Object.keys(result.projects[0]?.hosts[0]?.workspaces[0] ?? {}).sort()).toEqual([
      "currentBranch",
      "id",
      "name",
      "status",
      "workspaceKind",
    ]);
  });
});
