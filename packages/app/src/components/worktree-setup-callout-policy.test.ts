import { describe, expect, it } from "vitest";
import {
  buildWorktreeSetupCalloutPolicy,
  selectActiveGitWorkspaceProject,
  shouldShowWorktreeSetupCallout,
  type WorktreeSetupWorkspaceInput,
} from "./worktree-setup-callout-policy";

function gitWorkspace(
  overrides: Partial<WorktreeSetupWorkspaceInput> = {},
): WorktreeSetupWorkspaceInput {
  return {
    projectId: "project-1",
    projectKey: "project-1",
    projectKind: "git",
    projectRootPath: "/repo/project-1",
    ...overrides,
  };
}

describe("selectActiveGitWorkspaceProject", () => {
  it("selects the exact active git workspace project root", () => {
    expect(selectActiveGitWorkspaceProject("server-1", gitWorkspace())).toEqual({
      serverId: "server-1",
      projectId: "project-1",
      projectKey: "project-1",
      repoRoot: "/repo/project-1",
    });
  });

  it("uses the persisted project key for the settings route", () => {
    expect(
      selectActiveGitWorkspaceProject(
        "server-1",
        gitWorkspace({
          projectId: "prj_local",
          projectKey: "remote:github.com/acme/project",
        }),
      ),
    ).toMatchObject({
      projectId: "prj_local",
      projectKey: "remote:github.com/acme/project",
    });
  });

  it("preserves an opaque host-local project id in the settings route", () => {
    const project = selectActiveGitWorkspaceProject(
      "server-1",
      gitWorkspace({ projectId: "/repo/project " }),
    );

    expect(project?.projectId).toBe("/repo/project ");
    expect(project && buildWorktreeSetupCalloutPolicy(project).projectSettingsRoute).toBe(
      "/settings/projects/host%3A8%3Aserver-1%3Aproject%3A14%3A%2Frepo%2Fproject%20",
    );
  });

  it("ignores non-git workspaces and blank project coordinates", () => {
    expect(
      selectActiveGitWorkspaceProject("server-1", gitWorkspace({ projectKind: "local" })),
    ).toBe(null);
    expect(selectActiveGitWorkspaceProject("server-1", gitWorkspace({ projectId: " " }))).toBe(
      null,
    );
    expect(
      selectActiveGitWorkspaceProject("server-1", gitWorkspace({ projectRootPath: " " })),
    ).toBe(null);
  });
});

describe("shouldShowWorktreeSetupCallout", () => {
  it("shows the callout when paseo config was read and setup commands are missing", () => {
    expect(shouldShowWorktreeSetupCallout({ ok: true, config: {} })).toBe(true);
    expect(shouldShowWorktreeSetupCallout({ ok: true, config: null })).toBe(true);
  });

  it("does not show the callout when setup commands are present", () => {
    expect(
      shouldShowWorktreeSetupCallout({ ok: true, config: { worktree: { setup: "npm install" } } }),
    ).toBe(false);
    expect(
      shouldShowWorktreeSetupCallout({
        ok: true,
        config: { worktree: { setup: [" ", "npm install"] } },
      }),
    ).toBe(false);
  });

  it("does not show the callout when reading paseo config fails or has not completed", () => {
    expect(shouldShowWorktreeSetupCallout(undefined)).toBe(false);
    expect(shouldShowWorktreeSetupCallout({ ok: false })).toBe(false);
  });
});

describe("buildWorktreeSetupCalloutPolicy", () => {
  it("builds the stable sidebar callout identity and action route", () => {
    expect(
      buildWorktreeSetupCalloutPolicy({
        serverId: "server-1",
        projectId: "project-1",
        projectKey: "project-1",
        repoRoot: "/repo/project-1",
      }),
    ).toEqual({
      id: "worktree-setup-missing:host:8:server-1:project:9:project-1",
      dismissalKey: "worktree-setup-missing:host:8:server-1:project:9:project-1",
      priority: 100,
      title: "Set up worktree scripts",
      description:
        "Add setup commands so new worktrees can install dependencies and prepare themselves automatically.",
      actionLabel: "Open project settings",
      projectSettingsRoute: "/settings/projects/host%3A8%3Aserver-1%3Aproject%3A9%3Aproject-1",
      testID: "worktree-setup-callout-project-1",
    });
  });

  it("keeps the action route stable when the structural project key changes", () => {
    expect(
      buildWorktreeSetupCalloutPolicy({
        serverId: "server-1",
        projectId: "prj_local",
        projectKey: "remote:github.com/acme/project",
        repoRoot: "/repo/project",
      }).projectSettingsRoute,
    ).toBe("/settings/projects/host%3A8%3Aserver-1%3Aproject%3A9%3Aprj_local");
  });

  it("keeps dismissals scoped to the host placement", () => {
    const hostA = buildWorktreeSetupCalloutPolicy({
      serverId: "host-a",
      projectId: "project-a",
      projectKey: "remote:github.com/acme/project",
      repoRoot: "/host-a/project",
    });
    const hostB = buildWorktreeSetupCalloutPolicy({
      serverId: "host-b",
      projectId: "project-b",
      projectKey: "remote:github.com/acme/project",
      repoRoot: "/host-b/project",
    });

    expect(hostA.dismissalKey).not.toBe(hostB.dismissalKey);
  });

  it("scopes retained legacy project IDs to the active host", () => {
    expect(
      buildWorktreeSetupCalloutPolicy({
        serverId: "server-2",
        projectId: "remote:github.com/acme/project",
        projectKey: "remote:github.com/acme/project-fork",
        repoRoot: "/repo/project",
      }).projectSettingsRoute,
    ).toBe(
      "/settings/projects/host%3A8%3Aserver-2%3Aproject%3A30%3Aremote%3Agithub.com%2Facme%2Fproject",
    );
  });
});
