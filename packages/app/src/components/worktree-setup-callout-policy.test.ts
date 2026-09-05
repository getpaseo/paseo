import { describe, expect, it } from "vitest";
import {
  buildWorktreeSetupCalloutPolicy,
  selectActiveGitWorkspaceProject,
  shouldShowWorktreeSetupCallout,
} from "./worktree-setup-callout-policy";

describe("selectActiveGitWorkspaceProject", () => {
  it("selects the host-local project id for a git workspace", () => {
    expect(
      selectActiveGitWorkspaceProject("server-1", {
        projectId: "prj_local",
        projectKind: "git",
        projectRootPath: "/repo/project",
      }),
    ).toEqual({
      serverId: "server-1",
      projectId: "prj_local",
      repoRoot: "/repo/project",
    });
  });

  it("ignores non-git workspaces and blank coordinates", () => {
    expect(
      selectActiveGitWorkspaceProject("server-1", {
        projectId: "project",
        projectKind: "directory",
        projectRootPath: "/repo",
      }),
    ).toBeNull();
  });
});

describe("shouldShowWorktreeSetupCallout", () => {
  it("shows only after a successful config read with no setup command", () => {
    expect(shouldShowWorktreeSetupCallout({ ok: true, config: {} })).toBe(true);
    expect(
      shouldShowWorktreeSetupCallout({ ok: true, config: { worktree: { setup: "npm i" } } }),
    ).toBe(false);
    expect(
      shouldShowWorktreeSetupCallout({
        ok: true,
        config: { worktree: { setup: { win32: ["npm.cmd ci"] } } },
      }),
    ).toBe(false);
    expect(shouldShowWorktreeSetupCallout({ ok: false })).toBe(false);
  });
});

describe("buildWorktreeSetupCalloutPolicy", () => {
  it("routes by server id and project id", () => {
    expect(
      buildWorktreeSetupCalloutPolicy({
        serverId: "server-1",
        projectId: "prj_local",
        repoRoot: "/repo/project",
      }),
    ).toMatchObject({
      id: "worktree-setup-missing:server-1:prj_local",
      projectSettingsRoute: "/settings/hosts/server-1/projects/prj_local",
      testID: "worktree-setup-callout-prj_local",
    });
  });
});
