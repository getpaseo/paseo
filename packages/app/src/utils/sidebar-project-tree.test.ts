import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjectTree, flattenSidebarProjectTree } from "./sidebar-project-tree";

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
});
