import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { nestSidebarProjects } from "./sidebar-project-nesting";

function makeProject(viewKey: string, path: string, serverId = "host"): SidebarProjectEntry {
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
      makeProject("api", "/app/api"),
      makeProject("other", "/other"),
      makeProject("app", "/app"),
      makeProject("sdk", "/app/api/sdk"),
      makeProject("web", "/app/web"),
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

  it("does not confuse path prefixes, equal paths, or hosts", () => {
    const projects = [
      makeProject("app", "/app"),
      makeProject("same", "/app/"),
      makeProject("application", "/application"),
      makeProject("remote", "/app/api", "other-host"),
      makeProject("windows", "C:\\src\\app", "windows-host"),
      makeProject("windows-child", "C:/src/app/api", "windows-host"),
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
      ["remote", 0],
      ["windows", 0],
      ["windows-child", 1],
    ]);
  });

  it("keeps an equivalence project flat when its hosts disagree on the parent", () => {
    const shared = makeProject("shared", "/app/api");
    shared.hosts.push({
      serverId: "other-host",
      projectId: "shared",
      iconWorkingDir: "/api",
      worktreeSupport: "supported",
    });
    expect(
      nestSidebarProjects([makeProject("app", "/app"), shared], new Set()).map(
        ({ project, depth }) => [project.viewKey, depth],
      ),
    ).toEqual([
      ["app", 0],
      ["shared", 0],
    ]);
  });
});
