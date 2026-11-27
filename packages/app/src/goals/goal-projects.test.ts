import { describe, expect, it } from "vitest";
import {
  GOAL_PROJECT_FILTER_ALL,
  buildGoalProjectFilterOptions,
  buildGoalProjectOptions,
  describeGoalProject,
  filterGoalsByProject,
  findGoalProject,
  goalCwdCheckFromStatus,
  resolveGoalProjectDefault,
} from "./goal-projects";

function project(projectId: string, root: string, kind: "git" | "non_git" = "git") {
  return {
    projectId,
    projectDisplayName: projectId.toUpperCase(),
    projectRootPath: root,
    projectKind: kind,
  };
}

function workspace(projectId: string, directory: string, lastUserMessageAt: string | null) {
  return {
    projectId,
    workspaceDirectory: directory,
    lastUserMessageAt: lastUserMessageAt ? new Date(lastUserMessageAt) : null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const OPTIONS = buildGoalProjectOptions({
  projects: [
    project("api", "/home/mo/code/api"),
    project("web", "/home/mo/code/web/"),
    project("notes", "/home/mo/notes", "non_git"),
    project("cli", "/home/mo/code/cli"),
  ],
  workspaces: [
    workspace("api", "/home/mo/code/api", "2026-03-01T00:00:00Z"),
    workspace("web", "/home/mo/.paseo/worktrees/web/feature", "2026-05-01T00:00:00Z"),
    workspace("web", "/home/mo/code/web", null),
    workspace("notes", "/home/mo/notes", "2026-06-01T00:00:00Z"),
  ],
});

describe("buildGoalProjectOptions", () => {
  it("lists git projects only, most recently used first, never-used ones last by name", () => {
    expect(OPTIONS.map((option) => option.projectId)).toEqual(["web", "api", "cli"]);
  });

  it("keeps the root and every workspace directory, without trailing slashes", () => {
    expect(OPTIONS[0]).toMatchObject({
      name: "WEB",
      rootPath: "/home/mo/code/web",
      directories: ["/home/mo/code/web", "/home/mo/.paseo/worktrees/web/feature"],
      lastUsedAt: Date.parse("2026-05-01T00:00:00Z"),
    });
    expect(OPTIONS[2]?.lastUsedAt).toBeNull();
  });
});

describe("findGoalProject", () => {
  it("matches the root, a worktree of the project, or a folder inside the root", () => {
    expect(findGoalProject(OPTIONS, "/home/mo/code/api/")?.projectId).toBe("api");
    expect(findGoalProject(OPTIONS, "/home/mo/.paseo/worktrees/web/feature")?.projectId).toBe(
      "web",
    );
    expect(findGoalProject(OPTIONS, "/home/mo/code/cli/packages/core")?.projectId).toBe("cli");
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(findGoalProject(OPTIONS, "/home/mo/code/api-v2")).toBeNull();
    expect(findGoalProject(OPTIONS, "")).toBeNull();
  });
});

describe("describeGoalProject", () => {
  it("names a known directory by its project and an unknown one by its folder", () => {
    expect(describeGoalProject(OPTIONS, "/home/mo/code/api")).toEqual({
      name: "API",
      path: "~/code/api",
      known: true,
    });
    expect(describeGoalProject(OPTIONS, "/srv/other/")).toEqual({
      name: "other",
      path: "/srv/other",
      known: false,
    });
    expect(describeGoalProject(OPTIONS, null)).toBeNull();
  });
});

describe("resolveGoalProjectDefault", () => {
  it("takes the directory the form was opened from over the remembered one", () => {
    expect(
      resolveGoalProjectDefault({
        prefillCwd: "/home/mo/code/api",
        rememberedCwd: "/home/mo/code/cli",
        options: OPTIONS,
      }),
    ).toEqual({ cwd: "/home/mo/code/api", source: "prefill" });
  });

  it("falls back to the remembered project, then the most recently used one", () => {
    expect(
      resolveGoalProjectDefault({ prefillCwd: " ", rememberedCwd: "/r", options: OPTIONS }),
    ).toEqual({ cwd: "/r", source: "memory" });
    expect(resolveGoalProjectDefault({ options: OPTIONS })).toEqual({
      cwd: "/home/mo/code/web",
      source: "recent",
    });
    expect(resolveGoalProjectDefault({ options: [] })).toEqual({ cwd: "", source: "none" });
  });
});

describe("goalCwdCheckFromStatus", () => {
  it("reads checking, not a git checkout, a branch, and a detached HEAD", () => {
    expect(goalCwdCheckFromStatus("/a", null)).toEqual({ cwd: "/a", status: "checking" });
    expect(
      goalCwdCheckFromStatus("/a", { isGit: false, currentBranch: null, isDirty: null }),
    ).toEqual({ cwd: "/a", status: "notGit" });
    expect(
      goalCwdCheckFromStatus("/a", { isGit: true, currentBranch: "main", isDirty: true }),
    ).toEqual({ cwd: "/a", status: "git", branch: "main", dirty: true });
    expect(
      goalCwdCheckFromStatus("/a", { isGit: true, currentBranch: "HEAD", isDirty: false }),
    ).toEqual({ cwd: "/a", status: "git", branch: null, dirty: false });
  });
});

describe("project filter", () => {
  const goals = [
    { id: "g1", config: { cwd: "/home/mo/code/api" }, updatedAt: "2026-06-01T00:00:00Z" },
    {
      id: "g2",
      config: { cwd: "/home/mo/.paseo/worktrees/web/feature" },
      updatedAt: "2026-06-03T00:00:00Z",
    },
    { id: "g3", config: { cwd: "/home/mo/code/web" }, updatedAt: "2026-06-02T00:00:00Z" },
    { id: "g4", config: null, updatedAt: "2026-05-01T00:00:00Z" },
  ];

  it("groups goals by project, newest first, with manual goals under their own entry", () => {
    expect(buildGoalProjectFilterOptions(goals, OPTIONS, "No project")).toEqual([
      { key: "project:web", name: "WEB", path: "~/code/web", count: 2 },
      { key: "project:api", name: "API", path: "~/code/api", count: 1 },
      { key: "none", name: "No project", path: null, count: 1 },
    ]);
  });

  it("keeps one project's goals, and every goal for all or a key that is gone", () => {
    expect(filterGoalsByProject(goals, OPTIONS, "project:web").map((goal) => goal.id)).toEqual([
      "g2",
      "g3",
    ]);
    expect(filterGoalsByProject(goals, OPTIONS, GOAL_PROJECT_FILTER_ALL)).toHaveLength(4);
    expect(filterGoalsByProject(goals, OPTIONS, "project:gone")).toHaveLength(4);
  });
});
