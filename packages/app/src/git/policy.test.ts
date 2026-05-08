import { describe, expect, it } from "vitest";

import { buildGitActions, type BuildGitActionsInput } from "./policy";

function createInput(overrides: Partial<BuildGitActionsInput> = {}): BuildGitActionsInput {
  return {
    isGit: true,
    githubFeaturesEnabled: true,
    hasPullRequest: false,
    pullRequestUrl: null,
    pullRequestState: null,
    pullRequestIsDraft: false,
    pullRequestIsMerged: false,
    pullRequestMergeable: "UNKNOWN",
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
      "merge-pr-squash": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-pr-merge": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-pr-rebase": {
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
      "merge-pr-squash",
      "merge-pr-merge",
      "merge-pr-rebase",
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

  it("promotes squash-and-merge when an open PR is mergeable and the branch is in sync", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Squash and merge",
    });
  });

  it("respects the ship preference when choosing between PR merge and local merge", () => {
    const prPreferredActions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        shipDefault: "pr",
      }),
    );
    const localMergePreferredActions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        shipDefault: "merge",
      }),
    );

    expect(prPreferredActions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Squash and merge",
    });
    expect(localMergePreferredActions.primary).toMatchObject({
      id: "merge-branch",
      label: "Merge locally",
    });
    expect(
      localMergePreferredActions.secondary.some((action) => action.id === "merge-pr-squash"),
    ).toBe(true);
  });

  it("keeps the merge-pr actions in the feature branch menu", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
      }),
    );

    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "merge-pr-squash",
      "merge-pr-merge",
      "merge-pr-rebase",
    ]);
  });

  it("uses Merge locally for the local merge action", () => {
    const actions = buildGitActions(
      createInput({
        isOnBaseBranch: false,
        aheadCount: 2,
      }),
    );
    const action = actions.secondary.find((entry) => entry.id === "merge-branch");

    expect(action).toMatchObject({ label: "Merge locally" });
  });

  it.each([
    [
      "draft",
      { pullRequestIsDraft: true },
      "Merge PR isn't available because the pull request is still a draft",
    ],
    [
      "merged",
      { pullRequestIsMerged: true },
      "Merge PR isn't available because the pull request is already merged",
    ],
    [
      "closed",
      { pullRequestState: "closed" as const },
      "Merge PR isn't available because the pull request is closed",
    ],
    [
      "conflicting",
      { pullRequestMergeable: "CONFLICTING" as const },
      "Merge PR isn't available because the pull request has conflicts",
    ],
  ])("marks merge-pr actions unavailable when the PR is %s", (_name, overrides, message) => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        ...overrides,
      }),
    );
    const mergePrActions = actions.secondary.filter((action) =>
      ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
    );

    expect(mergePrActions).toHaveLength(3);
    expect(mergePrActions.map((action) => action.unavailableMessage)).toEqual([
      message,
      message,
      message,
    ]);
    expect(mergePrActions.map((action) => action.disabled)).toEqual([true, true, true]);
  });

  it("groups merge-pr actions behind their own menu separator via startsGroup", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        isPaseoOwnedWorktree: true,
      }),
    );

    const allActions = [...actions.secondary];

    const groupStarters = allActions
      .filter((action) => action.startsGroup)
      .map((action) => action.id);
    const nonGroupStarters = allActions
      .filter((action) => !action.startsGroup)
      .map((action) => action.id);

    expect(groupStarters).toEqual(["merge-from-base", "merge-pr-squash", "archive-worktree"]);
    expect(nonGroupStarters).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-branch",
      "pr",
      "merge-pr-merge",
      "merge-pr-rebase",
    ]);
  });
});
