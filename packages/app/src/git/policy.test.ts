import { describe, expect, it } from "vitest";
import { CheckoutPrStatusSchema } from "@getpaseo/protocol/messages";

import { buildGitActions, type BuildGitActionsInput } from "./policy";

function githubStatus(
  overrides: Partial<NonNullable<BuildGitActionsInput["pullRequestGithub"]>> = {},
): NonNullable<BuildGitActionsInput["pullRequestGithub"]> {
  return {
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: false,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  };
}

function createInput(overrides: Partial<BuildGitActionsInput> = {}): BuildGitActionsInput {
  return {
    isGit: true,
    githubFeaturesEnabled: true,
    githubAutoMergeActionsEnabled: true,
    hasPullRequest: false,
    pullRequestUrl: null,
    pullRequestState: null,
    pullRequestIsDraft: false,
    pullRequestIsMerged: false,
    pullRequestMergeable: "UNKNOWN",
    pullRequestGithub: null,
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
      "enable-pr-auto-merge-squash": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "enable-pr-auto-merge-merge": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "enable-pr-auto-merge-rebase": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "disable-pr-auto-merge": {
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
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus(),
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
        pullRequestGithub: githubStatus(),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Squash and merge",
    });
  });

  it("uses GitHub merge state, not mergeable, for direct merge readiness", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "UNKNOWN",
        pullRequestGithub: githubStatus({ mergeStateStatus: "CLEAN" }),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Squash and merge",
    });
  });

  it("offers direct PR merge when GitHub says the PR is mergeable even if the local branch is behind", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        behindBaseCount: 3,
        aheadOfOrigin: 0,
        behindOfOrigin: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({ mergeStateStatus: "CLEAN" }),
        shipDefault: "pr",
      }),
    );

    expect(actions.secondary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "merge-pr-squash",
          disabled: false,
          unavailableMessage: undefined,
        }),
        expect.objectContaining({
          id: "merge-pr-merge",
          disabled: false,
          unavailableMessage: undefined,
        }),
        expect.objectContaining({
          id: "merge-pr-rebase",
          disabled: false,
          unavailableMessage: undefined,
        }),
      ]),
    );
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
        pullRequestGithub: githubStatus(),
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
        pullRequestGithub: githubStatus(),
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
        pullRequestGithub: githubStatus(),
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

  it("keeps the visible PR action model stable on feature branches", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus(),
      }),
    );
    const pullRequestActions = actions.secondary
      .filter((action) =>
        ["pr", "merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
      )
      .map((action) => ({
        id: action.id,
        label: action.label,
        pendingLabel: action.pendingLabel,
        successLabel: action.successLabel,
        disabled: action.disabled,
        unavailableMessage: action.unavailableMessage,
        startsGroup: action.startsGroup,
      }));

    expect(pullRequestActions).toEqual([
      {
        id: "pr",
        label: "View PR",
        pendingLabel: "View PR",
        successLabel: "View PR",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: false,
      },
      {
        id: "merge-pr-squash",
        label: "Squash and merge",
        pendingLabel: "Merging PR...",
        successLabel: "PR merged",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: true,
      },
      {
        id: "merge-pr-merge",
        label: "Create a merge commit",
        pendingLabel: "Merging PR...",
        successLabel: "PR merged",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: false,
      },
      {
        id: "merge-pr-rebase",
        label: "Rebase and merge",
        pendingLabel: "Merging PR...",
        successLabel: "PR merged",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: false,
      },
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
    ["draft", { pullRequestIsDraft: true }],
    ["merged", { pullRequestIsMerged: true }],
    ["closed", { pullRequestState: "closed" as const }],
    ["conflicting", { pullRequestMergeable: "CONFLICTING" as const }],
  ])("does not offer direct merge actions when the PR is %s", (_name, overrides) => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus(),
        ...overrides,
      }),
    );
    const mergePrActions = actions.secondary.filter((action) =>
      ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
    );

    expect(mergePrActions).toEqual([]);
    expect(actions.secondary).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "pr", label: "View PR" })]),
    );
  });

  it("preserves legacy direct merge actions when old payloads have no GitHub facts", () => {
    const oldDaemonStatus = CheckoutPrStatusSchema.parse({
      number: 456,
      url: "https://example.com/pr/456",
      title: "Legacy payload",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      mergeable: "MERGEABLE",
    });
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: oldDaemonStatus.url,
        pullRequestState: "open",
        pullRequestIsDraft: oldDaemonStatus.isDraft,
        pullRequestIsMerged: oldDaemonStatus.isMerged,
        pullRequestMergeable: oldDaemonStatus.mergeable,
        pullRequestGithub: oldDaemonStatus.github,
        shipDefault: "pr",
      }),
    );

    expect(oldDaemonStatus.github).toBeUndefined();
    expect(actions.primary).toMatchObject({ id: "merge-pr-squash", label: "Squash and merge" });
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

  it("requires GitHub's direct-merge allowlist before promoting PR merge", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/993",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({
          mergeStateStatus: "BLOCKED",
          viewerCanEnableAutoMerge: true,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: false,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
        }),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "enable-pr-auto-merge-squash",
      label: "Enable auto-merge with squash",
    });
    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "enable-pr-auto-merge-squash",
    ]);
    expect(
      actions.secondary.some((action) =>
        ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
      ),
    ).toBe(false);
  });

  it("does not offer auto-merge when the daemon feature gate is missing", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/993",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({
          mergeStateStatus: "BLOCKED",
          viewerCanEnableAutoMerge: true,
        }),
        githubAutoMergeActionsEnabled: false,
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({ id: "pr", label: "View PR" });
    expect(actions.secondary.some((action) => action.id.startsWith("enable-pr-auto-merge"))).toBe(
      false,
    );
  });

  it("shows existing auto-merge as state and disables it when the viewer can", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({
          autoMergeRequest: {
            enabledAt: "2026-05-13T12:00:00Z",
            mergeMethod: "SQUASH",
            enabledBy: "octocat",
          },
          viewerCanDisableAutoMerge: true,
        }),
      }),
    );

    expect(actions.secondary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "disable-pr-auto-merge",
          label: "Auto-merge enabled",
          disabled: false,
          unavailableMessage: undefined,
        }),
      ]),
    );
    expect(
      actions.secondary.some((action) =>
        ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
      ),
    ).toBe(false);
  });

  it("respects repository merge method policy for direct merge actions", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: true,
            squashMergeAllowed: false,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
        }),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-pr-merge",
      label: "Create a merge commit",
    });
    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "merge-pr-merge",
    ]);
  });

  it("does not treat merge queue repositories as direct mergeable", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({
          mergeStateStatus: "CLEAN",
          isMergeQueueEnabled: true,
        }),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({ id: "pr", label: "View PR" });
    expect(
      actions.secondary.some((action) =>
        ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
      ),
    ).toBe(false);
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
        pullRequestGithub: githubStatus(),
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
