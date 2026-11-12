import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { nestSidebarProjects } from "./sidebar-project-nesting";

function makeProject(input: {
  viewKey: string;
  path: string;
  serverId?: string;
}): SidebarProjectEntry {
  const { viewKey, path, serverId = "host" } = input;
  return {
    viewKey,
    projectName: viewKey,
    projectKind: "git",
    iconWorkingDir: path,
    hosts: [{ serverId, projectId: viewKey, iconWorkingDir: path, worktreeSupport: "supported" }],
    workspaces: [],
  };
}

describe("nestSidebarProjects", () => {
  it("places descendants after their nearest parent and keeps sibling order", () => {
    const projects = [
      makeProject({ viewKey: "api", path: "/app/api" }),
      makeProject({ viewKey: "other", path: "/other" }),
      makeProject({ viewKey: "app", path: "/app" }),
      makeProject({ viewKey: "sdk", path: "/app/api/sdk" }),
      makeProject({ viewKey: "web", path: "/app/web" }),
    ];
    expect(
      nestSidebarProjects(projects, new Set()).map(({ project, depth }) => [
        project.viewKey,
        depth,
      ]),
    ).toEqual([
      ["other", 0],
      ["app", 0],
      ["api", 1],
      ["sdk", 2],
      ["web", 1],
    ]);
    expect(
      nestSidebarProjects(projects, new Set(["api"])).map(({ project }) => project.viewKey),
    ).toEqual(["other", "app", "api", "web"]);
  });

  it("keeps POSIX paths case-sensitive and matches mixed-case Windows paths", () => {
    const projects = [
      makeProject({ viewKey: "app", path: "/app" }),
      makeProject({ viewKey: "same", path: "/app/" }),
      makeProject({ viewKey: "application", path: "/application" }),
      makeProject({ viewKey: "posix-mixed", path: "/App/api" }),
      makeProject({ viewKey: "remote", path: "/app/api", serverId: "other-host" }),
      makeProject({ viewKey: "windows", path: "C:\\Projects\\App", serverId: "windows-host" }),
      makeProject({
        viewKey: "windows-child",
        path: "c:/projects/app/api",
        serverId: "windows-host",
      }),
    ];
    expect(
      nestSidebarProjects(projects, new Set()).map(({ project, depth }) => [
        project.viewKey,
        depth,
      ]),
    ).toEqual([
      ["app", 0],
      ["same", 0],
      ["application", 0],
      ["posix-mixed", 0],
      ["remote", 0],
      ["windows", 0],
      ["windows-child", 1],
    ]);
  });

  it("keeps an equivalence project flat when its hosts disagree on the parent", () => {
    const shared = makeProject({ viewKey: "shared", path: "/app/api" });
    shared.hosts.push({
      serverId: "other-host",
      projectId: "shared",
      iconWorkingDir: "/api",
      worktreeSupport: "supported",
    });
    expect(
      nestSidebarProjects([makeProject({ viewKey: "app", path: "/app" }), shared], new Set()).map(
        ({ project, depth }) => [project.viewKey, depth],
      ),
    ).toEqual([
      ["app", 0],
      ["shared", 0],
    ]);
  });
});
