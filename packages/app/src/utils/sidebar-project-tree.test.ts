import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  buildSidebarProjectTree,
  expandableProjectKeys,
  expandedProjectKeysForActiveWorkspaces,
  flattenSidebarProjectTree,
  reorderSidebarProjectTreeChildren,
} from "./sidebar-project-tree";

function project(
  projectKey: string,
  path: string,
  options: { serverId?: string; workspaceIds?: string[] } = {},
): SidebarProjectEntry {
  const serverId = options.serverId ?? "host";
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: path,
    hosts: [{ serverId, iconWorkingDir: path, canCreateWorktree: true }],
    workspaces: (options.workspaceIds ?? []).map((workspaceId) => ({
      workspaceKey: `${serverId}:${workspaceId}`,
      serverId,
      workspaceId,
      projectKey,
      projectName: projectKey,
      projectRootPath: path,
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: workspaceId,
    })),
  };
}

describe("buildSidebarProjectTree", () => {
  it("nests repository Projects under the nearest explicit client root", () => {
    const client = project("acme", "/code/acme");
    const api = project("api", "/code/acme/api");
    const nestedTool = project("tool", "/code/acme/api/tools/tool");
    const unrelated = project("other", "/code/other");

    const tree = buildSidebarProjectTree({
      projects: [client, api, nestedTool, unrelated],
    });

    expect(tree.map((node) => node.project.projectKey)).toEqual(["acme", "other"]);
    expect(tree[0]?.children.map((node) => node.project.projectKey)).toEqual(["api"]);
    expect(tree[0]?.children[0]?.children.map((node) => node.project.projectKey)).toEqual(["tool"]);
  });

  it("does not group equal paths, prefix collisions, or paths from different hosts", () => {
    const tree = buildSidebarProjectTree({
      projects: [
        project("root", "/code/acme"),
        project("same", "/code/acme"),
        project("prefix", "/code/acme-tools"),
        project("remote-child", "/code/acme/repo", { serverId: "other-host" }),
      ],
    });

    expect(tree.map((node) => node.project.projectKey)).toEqual([
      "root",
      "same",
      "prefix",
      "remote-child",
    ]);
  });

  it("handles Windows separators and drive-letter casing", () => {
    const tree = buildSidebarProjectTree({
      projects: [project("client", "C:\\Code\\Acme"), project("repo", "c:\\code\\acme\\repo")],
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.project.projectKey).toBe("repo");
  });

  it("leaves conflicting cross-host parent relationships ungrouped", () => {
    const first = project("first", "/code/client");
    first.hosts.push({
      serverId: "other-host",
      iconWorkingDir: "/code/client/repo",
      canCreateWorktree: true,
    });
    const second = project("second", "/code/client/repo");
    second.hosts.push({
      serverId: "other-host",
      iconWorkingDir: "/code/client",
      canCreateWorktree: true,
    });

    const tree = buildSidebarProjectTree({ projects: [first, second] });

    expect(tree.map((node) => node.project.projectKey)).toEqual(["first", "second"]);
  });

  it("restores a filtered parent as an empty shell for a visible child", () => {
    const parent = project("client", "/code/client", { workspaceIds: ["root-session"] });
    const child = project("repo", "/code/client/repo", { workspaceIds: ["repo-session"] });

    const tree = buildSidebarProjectTree({
      projects: [child],
      hierarchyProjects: [parent, child],
    });

    expect(tree[0]?.project.projectKey).toBe("client");
    expect(tree[0]?.project.workspaces).toEqual([]);
    expect(tree[0]?.children[0]?.project).toBe(child);
  });

  it("flattens reordered roots with their descendants kept together", () => {
    const clientA = project("client-a", "/code/client-a");
    const repoA = project("repo-a", "/code/client-a/repo");
    const clientB = project("client-b", "/code/client-b");
    const repoB = project("repo-b", "/code/client-b/repo");
    const tree = buildSidebarProjectTree({
      projects: [clientA, repoA, clientB, repoB],
    });

    expect(
      flattenSidebarProjectTree([tree[1]!, tree[0]!]).map((entry) => entry.projectKey),
    ).toEqual(["client-b", "repo-b", "client-a", "repo-a"]);
  });

  it("reorders nested siblings without changing their parent or surrounding Projects", () => {
    const client = project("client", "/code/client");
    const repoA = project("repo-a", "/code/client/repo-a");
    const repoB = project("repo-b", "/code/client/repo-b");
    const unrelated = project("unrelated", "/code/unrelated");
    const tree = buildSidebarProjectTree({
      projects: [client, repoA, repoB, unrelated],
    });

    const reorderedTree = reorderSidebarProjectTreeChildren({
      nodes: tree,
      parentProjectKey: "client",
      reorderedChildren: [tree[0]!.children[1]!, tree[0]!.children[0]!],
    });

    expect(flattenSidebarProjectTree(reorderedTree).map((entry) => entry.projectKey)).toEqual([
      "client",
      "repo-b",
      "repo-a",
      "unrelated",
    ]);
  });

  it("expands only the ancestry needed to reveal active workspaces", () => {
    const inactiveClient = project("inactive-client", "/code/inactive");
    const activeClient = project("active-client", "/code/active");
    const activeRepo = project("active-repo", "/code/active/repo", {
      workspaceIds: ["running"],
    });
    const inactiveRepo = project("inactive-repo", "/code/active/other");
    const tree = buildSidebarProjectTree({
      projects: [inactiveClient, activeClient, activeRepo, inactiveRepo],
    });

    const expanded = expandedProjectKeysForActiveWorkspaces({
      nodes: tree,
      activeWorkspaceKeys: new Set(["host:running"]),
    });

    expect(Array.from(expanded)).toEqual(["active-repo", "active-client"]);
    expect(expanded.has("inactive-client")).toBe(false);
    expect(expanded.has("inactive-repo")).toBe(false);
  });

  it("collapses every project when there are no active workspaces", () => {
    const tree = buildSidebarProjectTree({
      projects: [project("client", "/code/client"), project("repo", "/code/client/repo")],
    });

    expect(
      expandedProjectKeysForActiveWorkspaces({
        nodes: tree,
        activeWorkspaceKeys: new Set(),
      }),
    ).toEqual(new Set());
  });

  it("expands projects with workspaces and required ancestors but skips empty leaves", () => {
    const client = project("client", "/code/client");
    const repo = project("repo", "/code/client/repo", { workspaceIds: ["workspace"] });
    const emptyRepo = project("empty-repo", "/code/client/empty");
    const emptyRoot = project("empty-root", "/code/empty");
    const tree = buildSidebarProjectTree({
      projects: [client, repo, emptyRepo, emptyRoot],
    });

    expect(Array.from(expandableProjectKeys(tree))).toEqual(["repo", "client"]);
  });

  it("keeps an entire structural subtree collapsed when it has no workspaces", () => {
    const client = project("client", "/code/client");
    const repo = project("repo", "/code/client/repo");
    const tree = buildSidebarProjectTree({ projects: [client, repo] });

    expect(Array.from(expandableProjectKeys(tree))).toEqual([]);
  });
});
