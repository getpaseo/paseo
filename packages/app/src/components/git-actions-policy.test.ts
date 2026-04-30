import { describe, expect, it } from "vitest";

import { buildGitActions, type BuildGitActionsInput } from "./git-actions-policy";

function createInput(overrides: Partial<BuildGitActionsInput> = {}): BuildGitActionsInput {
  return {
    isGit: true,
    githubFeaturesEnabled: true,
    hasPullRequest: false,
    pullRequestUrl: null,
    hasRemote: false,
    isPaseoOwnedWorktree: false,
    isOnBaseBranch: true,
    hasUncommittedChanges: false,
    baseRefAvailable: true,
    baseRefLabel: "main",
    aheadCount: 0,
    behindBaseCount: 0,
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    shouldPromoteArchive: false,
    shipDefault: "merge",
    runtime: {
      commit: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      pull: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      push: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "pull-and-push": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      pr: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-branch": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-from-base": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "archive-worktree": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
    },
    ...overrides,
  };
}

describe("git-actions-policy", () => {
  it("shows only remote sync actions on the base branch", () => {
    const actions = buildGitActions(createInput({ hasRemote: true }));

    expect(actions.secondary.map((action) => action.id)).toEqual(["pull", "push", "pull-and-push"]);
  });

  it("prioritizes pull when the branch is behind origin", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        behindOfOrigin: 2,
      }),
    );

    expect(actions.primary).toMatchObject({ id: "pull", label: "Pull" });
  });

  it("keeps push clickable with a clearer message when the branch diverged", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        aheadOfOrigin: 1,
        behindOfOrigin: 1,
      }),
    );
    const pushAction = actions.secondary.find((action) => action.id === "push");

    expect(pushAction).toMatchObject({
      disabled: false,
      unavailableMessage:
        "Push isn't available yet because there are newer changes to bring in first",
    });
  });

  it("shows update-from-base only on feature branches that are behind the base branch", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        behindBaseCount: 3,
      }),
    );
    const updateAction = actions.secondary.find((action) => action.id === "merge-from-base");

    expect(updateAction).toMatchObject({
      label: "Update from main",
      disabled: false,
      unavailableMessage: undefined,
    });
  });

  it("uses a clear sentence when pull is unavailable", () => {
    const actions = buildGitActions(createInput({ hasRemote: true }));
    const pullAction = actions.secondary.find((action) => action.id === "pull");

    expect(pullAction).toMatchObject({
      disabled: false,
      unavailableMessage: "Pull isn't available because this branch is already up to date",
    });
  });

  it("keeps update-from-base off the base branch entirely", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        behindOfOrigin: 2,
      }),
    );

    expect(actions.secondary.some((action) => action.id === "merge-from-base")).toBe(false);
  });

  it("keeps feature branch actions available off the base branch", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        behindBaseCount: 1,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
      }),
    );

    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
    ]);
    expect(
      actions.secondary.some((action) => action.id === "pr" && action.label === "View PR"),
    ).toBe(true);
  });

  it("enables pull-and-push when the branch has both incoming and outgoing commits", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        aheadOfOrigin: 2,
        behindOfOrigin: 3,
      }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action).toMatchObject({
      label: "Pull and push",
      disabled: false,
      unavailableMessage: undefined,
    });
  });

  it("explains why pull-and-push is unavailable when the branch is in sync", () => {
    const actions = buildGitActions(createInput({ hasRemote: true }));
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action).toMatchObject({
      disabled: false,
      unavailableMessage: "Pull and push isn't available because this branch is already in sync",
    });
  });

  it("explains why pull-and-push is unavailable when there are uncommitted changes", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        hasUncommittedChanges: true,
        aheadOfOrigin: 1,
      }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action?.unavailableMessage).toBe(
      "Pull and push isn't available while you have local changes so commit or stash them first",
    );
  });

  it("only shows archive worktree for paseo worktrees", () => {
    const hidden = buildGitActions(createInput());
    const shown = buildGitActions(createInput({ isPaseoOwnedWorktree: true }));

    expect(hidden.secondary.some((action) => action.id === "archive-worktree")).toBe(false);
    expect(shown.secondary.some((action) => action.id === "archive-worktree")).toBe(true);
  });
});
