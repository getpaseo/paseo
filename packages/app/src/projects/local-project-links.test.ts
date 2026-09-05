import { describe, expect, test } from "vitest";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildProjectLinkGroupingOverrides,
  buildProjectLinkPlacements,
  buildProjectLinkSuggestions,
  deriveProjectGitIdentity,
  projectLinkPlacementKey,
  resolveProjectGitIdentity,
} from "./local-project-links";
import { linkLocalProjects, unlinkLocalProject } from "./local-project-links-store";

function project(input: {
  id: string;
  key?: string | null;
  root: string;
  name?: string;
}): ProjectDescriptor {
  return {
    projectId: input.id,
    projectKey: input.key ?? null,
    projectDisplayName: input.name ?? "acme/app",
    projectCustomName: null,
    projectRootPath: input.root,
    projectKind: "git",
  };
}

function workspace(input: {
  id: string;
  projectId: string;
  projectRoot: string;
  worktreeRoot: string;
  mainRepoRoot?: string;
  remote: string;
}): WorkspaceDescriptor {
  const checkout = input.mainRepoRoot
    ? {
        cwd: input.projectRoot,
        isGit: true as const,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: input.worktreeRoot,
        isPaseoOwnedWorktree: true as const,
        mainRepoRoot: input.mainRepoRoot,
      }
    : {
        cwd: input.projectRoot,
        isGit: true as const,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: input.worktreeRoot,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      };

  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: input.projectRoot,
    workspaceDirectory: input.projectRoot,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: { remoteUrl: input.remote },
    project: {
      projectKey: "legacy-key",
      projectName: "acme/app",
      checkout,
    },
  };
}

function hosts() {
  const projectA = project({ id: "prj-a", key: "legacy-a", root: "/repos/app/packages/web" });
  const projectB = project({ id: "prj-b", key: "legacy-b", root: "/work/app/packages/web" });
  return [
    {
      serverId: "host-a",
      serverName: "Desktop",
      projects: [projectA],
      workspaces: [
        workspace({
          id: "ws-a",
          projectId: projectA.projectId,
          projectRoot: projectA.projectRootPath,
          worktreeRoot: "/repos/app",
          remote: "ssh://git@ssh.github.com:443/Acme/App.git",
        }),
      ],
    },
    {
      serverId: "host-b",
      serverName: "Laptop",
      projects: [projectB],
      workspaces: [
        workspace({
          id: "ws-b",
          projectId: projectB.projectId,
          projectRoot: projectB.projectRootPath,
          worktreeRoot: "/work/app",
          remote: "https://github.com/acme/app.git",
        }),
      ],
    },
  ];
}

function suggestionIncludesExistingLinkMembers(suggestion: {
  placements: Array<{ serverId: string }>;
}): boolean {
  const serverIds = new Set<string>();
  for (const placement of suggestion.placements) serverIds.add(placement.serverId);
  return serverIds.has("host-a") && serverIds.has("host-b");
}

describe("local project links", () => {
  test("normalizes a Git remote and derives the selected project subdirectory", () => {
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "/repos/app/packages/web",
        worktreeRoot: "/repos/app",
        remoteUrl: "git@github.com:Acme/App.git",
      }),
    ).toEqual({
      repository: "github.com/acme/app",
      remoteDisplay: "github.com/acme/app",
      subdirectory: "packages/web",
    });
  });

  test("canonicalizes GitHub's SSH alias and transport port to the HTTPS repository", () => {
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "/repos/app",
        worktreeRoot: "/repos/app",
        remoteUrl: "ssh://git@ssh.github.com:443/Acme/App.git",
      }),
    ).toEqual({
      repository: "github.com/acme/app",
      remoteDisplay: "ssh.github.com:443/acme/app",
      subdirectory: "",
    });
  });

  test("omits SSH transport ports while preserving self-hosted HTTPS origin ports", () => {
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "/repos/app",
        worktreeRoot: "/repos/app",
        remoteUrl: "ssh://git@git.example.test:2222/team/app.git",
      }),
    ).toMatchObject({
      repository: "git.example.test/team/app",
      remoteDisplay: "git.example.test:2222/team/app",
    });
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "/repos/app",
        worktreeRoot: "/repos/app",
        remoteUrl: "https://git.example.test:60443/team/app.git",
      }),
    ).toMatchObject({
      repository: "git.example.test:60443/team/app",
      remoteDisplay: "git.example.test:60443/team/app",
    });
  });

  test("uses case-insensitive Windows ancestry checks while preserving subdirectory casing", () => {
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "C:\\Repos\\App\\Packages\\Web",
        worktreeRoot: "c:/repos/app",
        remoteUrl: "https://git.example.test/team/app.git",
      }),
    ).toMatchObject({
      repository: "git.example.test/team/app",
      subdirectory: "Packages/Web",
    });
  });

  test("uses the main checkout when resolving a managed worktree project", () => {
    const descriptor = project({ id: "prj-managed", root: "/repos/app/packages/web" });
    expect(
      resolveProjectGitIdentity({
        project: descriptor,
        workspaces: [
          workspace({
            id: "ws-managed",
            projectId: descriptor.projectId,
            projectRoot: descriptor.projectRootPath,
            worktreeRoot: "/repos/.paseo/worktrees/feature",
            mainRepoRoot: "/repos/app",
            remote: "https://github.com/acme/app.git",
          }),
        ],
      }),
    ).toEqual({
      repository: "github.com/acme/app",
      remoteDisplay: "github.com/acme/app",
      subdirectory: "packages/web",
    });
  });

  test("does not infer an identity when a project is outside its Git worktree", () => {
    expect(
      deriveProjectGitIdentity({
        projectRootPath: "/other/project",
        worktreeRoot: "/repos/app",
        remoteUrl: "https://github.com/acme/app.git",
      }),
    ).toBeNull();
  });

  test("rejects contradictory workspace Git facts for one project", () => {
    const descriptor = project({ id: "prj", root: "/repo/app" });
    expect(
      resolveProjectGitIdentity({
        project: descriptor,
        workspaces: [
          workspace({
            id: "one",
            projectId: descriptor.projectId,
            projectRoot: descriptor.projectRootPath,
            worktreeRoot: "/repo/app",
            remote: "https://github.com/acme/one.git",
          }),
          workspace({
            id: "two",
            projectId: descriptor.projectId,
            projectRoot: descriptor.projectRootPath,
            worktreeRoot: "/repo/app",
            remote: "https://github.com/acme/two.git",
          }),
        ],
      }),
    ).toBeNull();
  });

  test("suggests only exact cross-host matches that automatic grouping missed", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    expect(buildProjectLinkSuggestions({ placements, links: [] })).toEqual([
      expect.objectContaining({
        identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
        placements: [
          expect.objectContaining({ serverId: "host-a", projectId: "prj-a" }),
          expect.objectContaining({ serverId: "host-b", projectId: "prj-b" }),
        ],
      }),
    ]);

    const automaticallyGrouped = placements.map((placement) =>
      Object.assign({}, placement, {
        projectKey: "remote:github.com/acme/app#subdir:packages/web",
      }),
    );
    expect(buildProjectLinkSuggestions({ placements: automaticallyGrouped, links: [] })).toEqual(
      [],
    );

    const sameKeyDifferentProject = Object.assign({}, automaticallyGrouped[0]!, {
      projectId: "prj-a-other",
      identity: {
        repository: "github.com/acme/other",
        remoteDisplay: "github.com/acme/other",
        subdirectory: "packages/web",
      },
    });
    expect(
      buildProjectLinkSuggestions({
        placements: [...automaticallyGrouped, sameKeyDifferentProject],
        links: [],
      }),
    ).toEqual([
      expect.objectContaining({
        placements: [
          expect.objectContaining({ serverId: "host-a", projectId: "prj-a" }),
          expect.objectContaining({ serverId: "host-b", projectId: "prj-b" }),
        ],
      }),
    ]);

    const sameHostClone = {
      ...automaticallyGrouped[0]!,
      projectId: "prj-a-clone",
      projectName: "acme/app clone",
      projectRootPath: "/repos/clone/packages/web",
    };
    const manualPairs = buildProjectLinkSuggestions({
      placements: [...automaticallyGrouped, sameHostClone],
      links: [],
    });
    expect(manualPairs).toHaveLength(2);
    expect(manualPairs.every((suggestion) => suggestion.placements.length === 2)).toBe(true);
  });

  test("blocks automatic grouping when a saved link no longer verifies", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const link = {
      id: "link-1",
      members: placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
      identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
    };
    const active = buildProjectLinkGroupingOverrides({ placements, links: [link] });
    expect(active.get(projectLinkPlacementKey(placements[0]!))).toEqual({
      kind: "linked",
      linkId: "link-1",
    });

    const drifted = placements.map((placement) => {
      if (placement.serverId !== "host-b") return placement;
      return Object.assign({}, placement, {
        identity: {
          repository: "github.com/acme/other",
          remoteDisplay: "github.com/acme/other",
          subdirectory: "packages/web",
        },
      });
    });
    const blocked = buildProjectLinkGroupingOverrides({ placements: drifted, links: [link] });
    expect(blocked.get(projectLinkPlacementKey(drifted[0]!))).toEqual({ kind: "blocked" });
    expect(blocked.get(projectLinkPlacementKey(drifted[1]!))).toEqual({ kind: "blocked" });
  });

  test("does not block grouping when a linked host is omitted from the projection", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const link = {
      id: "link-1",
      members: placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
      identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
    };

    const overrides = buildProjectLinkGroupingOverrides({
      placements: [placements[0]!],
      links: [link],
    });

    expect(overrides).toEqual(new Map());
  });

  test("keeps a saved cloud SSH-alias link valid after remote canonicalization", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const link = {
      id: "link-1",
      members: placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
      identity: {
        repository: "ssh.github.com:443/acme/app",
        subdirectory: "packages/web",
      },
    };

    const overrides = buildProjectLinkGroupingOverrides({ placements, links: [link] });
    for (const placement of placements) {
      expect(overrides.get(projectLinkPlacementKey(placement))).toEqual({
        kind: "linked",
        linkId: "link-1",
      });
    }
  });

  test("offers a verified new host as an addition to an existing local link", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const existingLink = {
      id: "link-1",
      members: placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
      identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
    };
    const newHost = {
      ...placements[1]!,
      serverId: "host-c",
      serverName: "Server",
      projectId: "prj-c",
      projectKey: "legacy-c",
      projectRootPath: "/srv/app/packages/web",
    };

    expect(
      buildProjectLinkSuggestions({
        placements: [...placements, newHost],
        links: [existingLink],
      }),
    ).toEqual([
      expect.objectContaining({
        placements: [
          expect.objectContaining({ serverId: "host-a" }),
          expect.objectContaining({ serverId: "host-b" }),
          expect.objectContaining({ serverId: "host-c" }),
        ],
      }),
    ]);
  });

  test("offers later matching hosts as additions instead of a competing second link", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const existingLink = {
      id: "link-1",
      members: placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
      identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
    };
    const hostC = Object.assign({}, placements[1]!, {
      serverId: "host-c",
      serverName: "Server",
      projectId: "prj-c",
      projectKey: "legacy-c",
      projectRootPath: "/srv/app/packages/web",
    });
    const hostD = Object.assign({}, placements[1]!, {
      serverId: "host-d",
      serverName: "Tablet",
      projectId: "prj-d",
      projectKey: "legacy-d",
      projectRootPath: "/tablet/app/packages/web",
    });

    const suggestions = buildProjectLinkSuggestions({
      placements: [...placements, hostC, hostD],
      links: [existingLink],
    });

    expect(suggestions).toHaveLength(2);
    expect(suggestions.every(suggestionIncludesExistingLinkMembers)).toBe(true);
  });

  test("offers separate verified links for the same identity as one merge", () => {
    const placements = buildProjectLinkPlacements({ hosts: hosts() });
    const hostC = Object.assign({}, placements[1]!, {
      serverId: "host-c",
      serverName: "Server",
      projectId: "prj-c",
      projectKey: "legacy-c",
      projectRootPath: "/srv/app/packages/web",
    });
    const hostD = Object.assign({}, placements[1]!, {
      serverId: "host-d",
      serverName: "Tablet",
      projectId: "prj-d",
      projectKey: "legacy-d",
      projectRootPath: "/tablet/app/packages/web",
    });
    const allPlacements = [...placements, hostC, hostD];

    const suggestions = buildProjectLinkSuggestions({
      placements: allPlacements,
      links: [
        {
          id: "link-1",
          members: [
            { serverId: "host-a", projectId: "prj-a" },
            { serverId: "host-b", projectId: "prj-b" },
          ],
          identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
        },
        {
          id: "link-2",
          members: [
            { serverId: "host-c", projectId: "prj-c" },
            { serverId: "host-d", projectId: "prj-d" },
          ],
          identity: { repository: "github.com/acme/app", subdirectory: "packages/web" },
        },
      ],
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        placements: expect.arrayContaining([
          expect.objectContaining({ serverId: "host-a" }),
          expect.objectContaining({ serverId: "host-b" }),
          expect.objectContaining({ serverId: "host-c" }),
          expect.objectContaining({ serverId: "host-d" }),
        ]),
      }),
    ]);
  });

  test("merges matching local links and drops a link when a member is unlinked", () => {
    const identity = { repository: "github.com/acme/app", subdirectory: "" };
    const initial = linkLocalProjects({
      links: [],
      members: [
        { serverId: "host-a", projectId: "prj-a" },
        { serverId: "host-b", projectId: "prj-b" },
      ],
      identity,
      id: "link-1",
    });
    const expanded = linkLocalProjects({
      links: initial,
      members: [
        { serverId: "host-b", projectId: "prj-b" },
        { serverId: "host-c", projectId: "prj-c" },
      ],
      identity,
    });
    expect(expanded).toEqual([
      expect.objectContaining({
        id: "link-1",
        members: [
          { serverId: "host-b", projectId: "prj-b" },
          { serverId: "host-c", projectId: "prj-c" },
          { serverId: "host-a", projectId: "prj-a" },
        ],
      }),
    ]);
    expect(
      unlinkLocalProject({
        links: expanded,
        placement: { serverId: "host-a", projectId: "prj-a" },
      }),
    ).toEqual([
      expect.objectContaining({
        members: [
          { serverId: "host-b", projectId: "prj-b" },
          { serverId: "host-c", projectId: "prj-c" },
        ],
      }),
    ]);
  });
});
