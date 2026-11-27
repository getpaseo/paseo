import { afterEach, describe, expect, it } from "vitest";
import { CheckoutPrStatusSchema } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

import {
  actionsWithoutPrimary,
  buildGitActions,
  isCurrentBranchBase,
  canMergeIntoLocalBase,
  readSyncRemotes,
  readUpstreamState,
  type BuildGitActionsInput,
} from "./policy";
import { deriveMergeCapability, type ForgeSpecificStatusFacts } from "./merge-capability";
import { BUILTIN_CLIENT_FORGE_HOST } from "./client-forge-registry";

type GithubMergeFactsFixture = ForgeSpecificStatusFacts & {
  forge: "github";
  mergeStateStatus: string | null;
  autoMergeRequest: {
    enabledAt: string | null;
    mergeMethod: string | null;
    enabledBy: string | null;
  } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  viewerCanMergeAsAdmin: boolean;
  viewerCanUpdateBranch: boolean;
  repository: {
    autoMergeAllowed: boolean;
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    viewerDefaultMergeMethod: string | null;
  };
  isMergeQueueEnabled: boolean;
  isInMergeQueue: boolean;
};

function githubStatus(overrides: Partial<GithubMergeFactsFixture> = {}): GithubMergeFactsFixture {
  return {
    forge: "github",
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

function createInput(
  overrides: Partial<Omit<BuildGitActionsInput, "mergeCapability">> & {
    pullRequestGithub?: unknown;
    // Shorthand for a branch that both Pull and Push have a remote for.
    hasRemote?: boolean;
  } = {},
): BuildGitActionsInput {
  const { pullRequestGithub = null, hasRemote = false, ...rest } = overrides;
  return {
    isGit: true,
    githubFeaturesEnabled: true,
    forgeBrandLabel: "GitHub",
    forgeChangeRequestNoun: "PR",
    githubAutoMergeActionsEnabled: true,
    hasPullRequest: false,
    pullRequestUrl: null,
    pullRequestState: null,
    pullRequestIsDraft: false,
    pullRequestIsMerged: false,
    pullRequestMergeable: "UNKNOWN",
    mergeCapability: deriveMergeCapability(pullRequestGithub, BUILTIN_CLIENT_FORGE_HOST),
    hasPullRemote: hasRemote,
    hasPushRemote: hasRemote,
    upstream: "tracked",
    isPaseoOwnedWorktree: false,
    isOnBaseBranch: true,
    canMergeLocally: true,
    hasUncommittedChanges: false,
    baseRefAvailable: true,
    baseRefLabel: "main",
    aheadCount: 0,
    behindBaseCount: 0,
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    shouldPromoteArchive: false,
    shipDefault: "pr",
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
      "archive-workspace": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
    },
    ...rest,
  };
}

function pushActionOf(actions: ReturnType<typeof buildGitActions>) {
  return actions.secondary.find((action) => action.id === "push");
}

function pullAndPushActionOf(actions: ReturnType<typeof buildGitActions>) {
  return actions.secondary.find((action) => action.id === "pull-and-push");
}

describe("git-actions-policy", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows only remote sync actions on the base branch", () => {
    const actions = buildGitActions(createInput({ hasRemote: true }));

    expect(actions.primary).toBeNull();
    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "archive-workspace",
    ]);
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

  it("drops a promoted remote action from the remaining menu actions", () => {
    const pull = buildGitActions(createInput({ hasRemote: true, behindOfOrigin: 2 }));
    expect(pull.primary?.id).toBe("pull");
    expect(actionsWithoutPrimary(pull).map((action) => action.id)).toEqual([
      "push",
      "pull-and-push",
      "archive-workspace",
    ]);

    const push = buildGitActions(createInput({ hasRemote: true, aheadOfOrigin: 1 }));
    expect(push.primary?.id).toBe("push");
    expect(actionsWithoutPrimary(push).map((action) => action.id)).toEqual([
      "pull",
      "pull-and-push",
      "archive-workspace",
    ]);
  });

  it("distinguishes exact local and remote base refs and retains legacy names", () => {
    expect(isCurrentBranchBase("release", "refs/heads/release")).toBe(true);
    expect(isCurrentBranchBase("release", "refs/remotes/origin/release")).toBe(false);
    expect(isCurrentBranchBase("release", "release")).toBe(true);
    expect(isCurrentBranchBase("release", "origin/release")).toBe(true);
    expect(isCurrentBranchBase(null, "refs/heads/release")).toBe(false);
    expect(canMergeIntoLocalBase("release", "refs/heads/release")).toBe(false);
    expect(canMergeIntoLocalBase("feature", "refs/remotes/origin/release")).toBe(true);
    expect(canMergeIntoLocalBase("release", "refs/remotes/upstream/release")).toBe(false);
  });

  it("offers local merge when the selected local base starts with origin slash", () => {
    const actions = buildGitActions(
      createInput({
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: isCurrentBranchBase("release", "refs/heads/origin/release"),
        canMergeLocally: canMergeIntoLocalBase("release", "refs/heads/origin/release"),
        baseRefLabel: "origin/release",
        aheadCount: 1,
        shipDefault: "merge",
      }),
    );
    expect(actions.primary?.id).toBe("merge-branch");
  });

  it("offers update but not local merge for a non-origin remote base", () => {
    const actions = buildGitActions(
      createInput({
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: false,
        canMergeLocally: canMergeIntoLocalBase("feature", "refs/remotes/upstream/release"),
        baseRefLabel: "upstream/release",
        aheadCount: 1,
        behindBaseCount: 1,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        shipDefault: "merge",
      }),
    );
    expect(actions.primary?.id).toBe("merge-from-base");
    expect(actionsWithoutPrimary(actions).map((action) => action.id)).not.toContain("merge-branch");
  });

  it("does not offer merging into the current local branch when the remote base shares its name", () => {
    const actions = buildGitActions(
      createInput({
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: false,
        canMergeLocally: canMergeIntoLocalBase("release", "refs/remotes/origin/release"),
        baseRefLabel: "release",
        aheadCount: 1,
        behindBaseCount: 1,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        shipDefault: "merge",
      }),
    );
    expect(actions.primary?.id).toBe("merge-from-base");
    expect(actionsWithoutPrimary(actions).map((action) => action.id)).not.toContain("merge-branch");
  });

  it("offers update from the same-named remote base when it is ahead", () => {
    const actions = buildGitActions(
      createInput({
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: isCurrentBranchBase("release", "refs/remotes/origin/release"),
        baseRefLabel: "release",
        behindBaseCount: 1,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      }),
    );
    expect(actions.primary?.id).toBe("merge-from-base");
  });

  it("drops a promoted merge action from the remaining menu actions", () => {
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

    expect(actions.primary).toMatchObject({ id: "merge-pr-merge", label: "Merge PR (merge)" });
    expect(actionsWithoutPrimary(actions).map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "archive-workspace",
    ]);
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

  it("keeps push available for a no-upstream Paseo worktree with local commits", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        upstream: "none",
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: false,
        aheadCount: 1,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      }),
    );
    const pushAction = actions.secondary.find((action) => action.id === "push");

    expect(pushAction).toMatchObject({
      disabled: false,
      unavailableMessage: undefined,
    });
  });

  it("re-publishes a Paseo worktree branch whose remote copy was deleted", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        upstream: "gone",
        isPaseoOwnedWorktree: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        shipDefault: "pr",
      }),
    );
    const pushAction = actions.secondary.find((action) => action.id === "push");

    expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
    expect(pushAction).toMatchObject({ disabled: false, unavailableMessage: undefined });
  });

  describe("a never-pushed branch in a regular checkout", () => {
    const neverPushed = {
      hasRemote: true,
      upstream: "none",
      isOnBaseBranch: false,
      aheadCount: 1,
      aheadOfOrigin: null,
      behindOfOrigin: null,
    } as const;

    it("offers Push first, ahead of Create PR", () => {
      const actions = buildGitActions(createInput({ ...neverPushed, shipDefault: "pr" }));

      expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
    });

    it("offers Push first, ahead of Merge locally", () => {
      const actions = buildGitActions(
        createInput({ ...neverPushed, githubFeaturesEnabled: false, shipDefault: "merge" }),
      );

      expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
    });

    it("does not offer Push when it has no commits of its own", () => {
      const actions = buildGitActions(createInput({ ...neverPushed, aheadCount: 0 }));
      const pushAction = pushActionOf(actions);

      expect(actions.primary?.id).not.toBe("push");
      expect(pushAction?.unavailableMessage).toBe(
        "Push isn't available because there is nothing new to send",
      );
    });

    it("does not offer Push when the repository has no origin", () => {
      const actions = buildGitActions(createInput({ ...neverPushed, hasRemote: false }));
      const pushAction = pushActionOf(actions);

      expect(actions.primary?.id).not.toBe("push");
      expect(pushAction?.unavailableMessage).toBe(
        "Push isn't available here because this branch is not connected to a remote yet",
      );
    });

    it("does not offer Push when Git pushes the branch to another remote", () => {
      const actions = buildGitActions(createInput({ ...neverPushed, hasPushRemote: false }));
      const pushAction = pushActionOf(actions);

      expect(actions.primary?.id).not.toBe("push");
      expect(pushAction?.unavailableMessage).toBe(
        "Push isn't available here because this branch is not connected to a remote yet",
      );
    });
  });

  // The daemon reports where Pull and Push go for the branch, so the remote's name never matters.
  describe("a branch that tracks a remote other than origin", () => {
    const tracksDorasMono = readSyncRemotes({
      hasRemote: false,
      pullRemote: "doras-mono",
      pushRemote: "doras-mono",
      upstreamState: "tracked",
      aheadOfOrigin: 1,
      isPaseoOwnedWorktree: false,
    });

    it("offers Push when the branch is ahead", () => {
      const actions = buildGitActions(
        createInput({ ...tracksDorasMono, aheadOfOrigin: 1, behindOfOrigin: 0 }),
      );

      expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
      expect(pushActionOf(actions)).toMatchObject({
        disabled: false,
        unavailableMessage: undefined,
      });
    });

    it("offers Pull when the branch is behind", () => {
      const actions = buildGitActions(
        createInput({ ...tracksDorasMono, aheadOfOrigin: 0, behindOfOrigin: 2 }),
      );

      expect(actions.primary).toMatchObject({ id: "pull", label: "Pull" });
    });

    it("offers Pull first and Pull and push when the branch is ahead and behind", () => {
      const actions = buildGitActions(
        createInput({ ...tracksDorasMono, aheadOfOrigin: 1, behindOfOrigin: 2 }),
      );

      expect(actions.primary).toMatchObject({ id: "pull", label: "Pull" });
      expect(pullAndPushActionOf(actions)).toMatchObject({
        disabled: false,
        unavailableMessage: undefined,
      });
      expect(pushActionOf(actions)?.unavailableMessage).toBe(
        "Push isn't available yet because there are newer changes to bring in first",
      );
    });

    // `feature` tracking `upstream/main`: the daemon reports a pull remote and no push remote.
    const pullOnly = readSyncRemotes({
      hasRemote: false,
      pullRemote: "upstream",
      pushRemote: null,
      upstreamState: "tracked",
      aheadOfOrigin: 1,
      isPaseoOwnedWorktree: false,
    });

    it("does not offer Push when it would land on a differently named upstream branch", () => {
      const actions = buildGitActions(
        createInput({ ...pullOnly, aheadOfOrigin: 1, behindOfOrigin: 0 }),
      );

      expect(actions.primary?.id).not.toBe("push");
      expect(pushActionOf(actions)?.unavailableMessage).toBe(
        "Push isn't available here because this branch is not connected to a remote yet",
      );
    });

    it("still offers Pull for that branch, and not Pull and push", () => {
      const actions = buildGitActions(
        createInput({ ...pullOnly, aheadOfOrigin: 1, behindOfOrigin: 2 }),
      );

      expect(actions.primary).toMatchObject({ id: "pull", label: "Pull" });
      expect(pullAndPushActionOf(actions)?.unavailableMessage).toBe(
        "Pull and push isn't available here because this branch is not connected to a remote yet",
      );
    });
  });

  describe("readSyncRemotes", () => {
    it("uses the remotes the daemon reports", () => {
      expect(
        readSyncRemotes({
          hasRemote: true,
          pullRemote: null,
          pushRemote: "origin",
          upstreamState: "none",
          aheadOfOrigin: null,
          isPaseoOwnedWorktree: false,
        }),
      ).toEqual({ hasPullRemote: false, hasPushRemote: true });
    });

    // The rest covers a daemon that predates pullRemote and pushRemote.
    const tracked = {
      upstreamState: "tracked",
      aheadOfOrigin: 1,
      isPaseoOwnedWorktree: false,
    } as const;
    const neverPushed = {
      upstreamState: "none",
      aheadOfOrigin: null,
      isPaseoOwnedWorktree: false,
    } as const;

    it("pulls and pushes a tracked branch on an older daemon only when the checkout has origin", () => {
      expect(readSyncRemotes({ ...tracked, hasRemote: true })).toEqual({
        hasPullRemote: true,
        hasPushRemote: true,
      });
      expect(readSyncRemotes({ ...tracked, hasRemote: false })).toEqual({
        hasPullRemote: false,
        hasPushRemote: false,
      });
    });

    it("makes a regular checkout's first push only where an older daemon confirmed it", () => {
      expect(
        readSyncRemotes({ ...neverPushed, hasRemote: true, firstPushRemote: "origin" }),
      ).toMatchObject({ hasPushRemote: true });
      expect(
        readSyncRemotes({ ...neverPushed, hasRemote: true, firstPushRemote: null }),
      ).toMatchObject({ hasPushRemote: false });
    });

    it("keeps a Paseo worktree's first push on an older daemon that reports no first push remote", () => {
      expect(
        readSyncRemotes({
          ...neverPushed,
          hasRemote: true,
          firstPushRemote: null,
          isPaseoOwnedWorktree: true,
        }),
      ).toMatchObject({ hasPushRemote: true });
    });
  });

  it("does not offer a first push when the branch's remote copy was deleted", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        upstream: "gone",
        isOnBaseBranch: false,
        aheadCount: 2,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        shipDefault: "pr",
      }),
    );
    const pushAction = actions.secondary.find((action) => action.id === "push");

    expect(actions.primary).toMatchObject({ id: "pr", label: "Create PR" });
    expect(pushAction?.unavailableMessage).toBe(
      "Push isn't available because the branch this one tracks no longer exists",
    );
  });

  describe("a published branch whose upstream the daemon cannot read", () => {
    const unreadableUpstream = {
      hasRemote: true,
      upstream: "unknown",
      isOnBaseBranch: false,
      aheadCount: 2,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      shipDefault: "pr",
    } as const;

    it("does not offer a first push in a regular checkout", () => {
      const actions = buildGitActions(createInput(unreadableUpstream));

      expect(actions.primary).toMatchObject({ id: "pr", label: "Create PR" });
      expect(pushActionOf(actions)?.unavailableMessage).toEqual(expect.any(String));
    });

    it("keeps offering Push in a Paseo worktree", () => {
      const actions = buildGitActions(
        createInput({ ...unreadableUpstream, isPaseoOwnedWorktree: true }),
      );

      expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
      expect(pushActionOf(actions)).toMatchObject({
        disabled: false,
        unavailableMessage: undefined,
      });
    });
  });

  describe("readUpstreamState", () => {
    it("uses the upstream state the daemon reports", () => {
      expect(
        readUpstreamState({
          upstreamState: "none",
          aheadOfOrigin: null,
          isPaseoOwnedWorktree: false,
        }),
      ).toBe("none");
      expect(
        readUpstreamState({
          upstreamState: "gone",
          aheadOfOrigin: null,
          isPaseoOwnedWorktree: true,
        }),
      ).toBe("gone");
    });

    it("keeps the old guess for daemons that predate upstream states", () => {
      expect(
        readUpstreamState({
          upstreamState: undefined,
          aheadOfOrigin: 1,
          isPaseoOwnedWorktree: false,
        }),
      ).toBe("tracked");
      expect(
        readUpstreamState({
          upstreamState: undefined,
          aheadOfOrigin: null,
          isPaseoOwnedWorktree: true,
        }),
      ).toBe("none");
      expect(
        readUpstreamState({
          upstreamState: undefined,
          aheadOfOrigin: null,
          isPaseoOwnedWorktree: false,
        }),
      ).toBe("unknown");
    });

    it("keeps an old daemon's never-pushed regular branch off Push", () => {
      const actions = buildGitActions(
        createInput({
          hasRemote: true,
          upstream: readUpstreamState({
            upstreamState: undefined,
            aheadOfOrigin: null,
            isPaseoOwnedWorktree: false,
          }),
          isOnBaseBranch: false,
          aheadCount: 1,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          githubFeaturesEnabled: false,
          shipDefault: "merge",
        }),
      );
      const pushAction = pushActionOf(actions);

      expect(actions.primary).toMatchObject({ id: "merge-branch" });
      expect(pushAction?.unavailableMessage).toBe(
        "Push isn't available because there is nothing new to send",
      );
    });
  });

  it("prioritizes push over pull request merge when local commits are unpushed", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        aheadOfOrigin: 2,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus(),
        shipDefault: "pr",
      }),
    );

    expect(actions.primary).toMatchObject({ id: "push", label: "Push" });
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
      "archive-workspace",
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

  it("keeps pull-and-push unavailable when the branch only has outgoing commits", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        aheadOfOrigin: 2,
        behindOfOrigin: 0,
      }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action).toMatchObject({
      label: "Pull and push",
      unavailableMessage: expect.any(String),
    });
  });

  it("keeps pull-and-push unavailable when the branch only has incoming commits", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        aheadOfOrigin: 0,
        behindOfOrigin: 2,
      }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action).toMatchObject({
      label: "Pull and push",
      unavailableMessage: expect.any(String),
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

  it("explains why pull-and-push is unavailable when there is nothing to pull first", () => {
    const actions = buildGitActions(
      createInput({ hasRemote: true, aheadOfOrigin: 1, behindOfOrigin: 0 }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action?.unavailableMessage).toBe(
      "Pull and push isn't available because there are no incoming changes to pull first",
    );
  });

  it("explains why pull-and-push is unavailable when there is nothing to push after pulling", () => {
    const actions = buildGitActions(
      createInput({ hasRemote: true, aheadOfOrigin: 0, behindOfOrigin: 1 }),
    );
    const action = actions.secondary.find((entry) => entry.id === "pull-and-push");

    expect(action?.unavailableMessage).toBe(
      "Pull and push isn't available because there is nothing new to send after pulling",
    );
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

  it("hides Git actions for a non-Git workspace", () => {
    const directory = buildGitActions(createInput({ isGit: false }));

    expect(directory).toEqual({ primary: null, secondary: [], menu: [] });
  });

  it("offers archive workspace for Git checkouts and worktrees", () => {
    const localCheckout = buildGitActions(createInput({ hasUncommittedChanges: true }));
    const worktree = buildGitActions(
      createInput({ hasUncommittedChanges: true, isPaseoOwnedWorktree: true }),
    );

    expect(localCheckout.secondary.some((action) => action.id === "archive-workspace")).toBe(true);
    expect(worktree.secondary.some((action) => action.id === "archive-workspace")).toBe(true);
  });

  it("does not promote archive to primary for an idle regular Git checkout", () => {
    const actions = buildGitActions(createInput());

    expect(actions.primary).toBeNull();
    expect(actions.secondary.some((action) => action.id === "archive-workspace")).toBe(true);
  });

  it("still promotes archive as primary for an idle Paseo-owned worktree", () => {
    const actions = buildGitActions(createInput({ isPaseoOwnedWorktree: true }));

    expect(actions.primary).toMatchObject({ id: "archive-workspace" });
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
      label: "Merge PR (squash)",
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
      label: "Merge PR (squash)",
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

  it("promotes ready PR merge over update-from-base", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        behindBaseCount: 3,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
        pullRequestState: "open",
        pullRequestMergeable: "MERGEABLE",
        pullRequestGithub: githubStatus({ mergeStateStatus: "CLEAN" }),
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Merge PR (squash)",
    });
  });

  it("promotes push over Create PR when local commits are unpushed", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        aheadOfOrigin: 2,
        behindBaseCount: 3,
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "push",
      label: "Push",
    });
  });

  it("uses the forge change-request noun in unavailable no-forge copy", () => {
    const createActions = buildGitActions(
      createInput({
        githubFeaturesEnabled: false,
        forgeBrandLabel: "GitLab",
        forgeChangeRequestNoun: "MR",
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 1,
      }),
    );
    const viewActions = buildGitActions(
      createInput({
        githubFeaturesEnabled: false,
        forgeBrandLabel: "GitLab",
        forgeChangeRequestNoun: "MR",
        hasRemote: true,
        isOnBaseBranch: false,
        hasPullRequest: true,
        pullRequestUrl: "https://gitlab.com/example/repo/-/merge_requests/1",
      }),
    );

    const createPrAction = [...createActions.secondary, ...createActions.menu].find(
      (action) => action.id === "pr",
    );
    const viewPrAction = [viewActions.primary, ...viewActions.secondary, ...viewActions.menu].find(
      (action) => action?.id === "pr",
    );

    expect(createPrAction?.unavailableMessage).toBe(
      "Create MR isn't available right now because GitLab isn't connected",
    );
    expect(viewPrAction?.unavailableMessage).toBe(
      "View MR isn't available right now because GitLab isn't connected",
    );
  });

  it("uses local merge when merge is the stored ship default", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        isOnBaseBranch: false,
        aheadCount: 2,
        behindBaseCount: 3,
        shipDefault: "merge",
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "merge-branch",
      label: "Merge locally",
    });
  });

  it("promotes ready PR merge over local merge", () => {
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

    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Merge PR (squash)",
    });
    expect(actions.secondary.some((action) => action.id === "merge-branch")).toBe(true);
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
      "archive-workspace",
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
        label: "Merge PR (squash)",
        pendingLabel: "Merging PR...",
        successLabel: "PR merged",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: true,
      },
      {
        id: "merge-pr-merge",
        label: "Merge PR (merge)",
        pendingLabel: "Merging PR...",
        successLabel: "PR merged",
        disabled: false,
        unavailableMessage: undefined,
        startsGroup: false,
      },
      {
        id: "merge-pr-rebase",
        label: "Merge PR (rebase)",
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

  it("uses the active language for policy-owned action labels and unavailable messages", async () => {
    await i18n.changeLanguage("zh-CN");
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        behindOfOrigin: 1,
        isOnBaseBranch: false,
        aheadCount: 0,
      }),
    );

    expect(actions.primary).toMatchObject({
      id: "pull",
      label: "Pull",
      pendingLabel: "正在 pull...",
      successLabel: "已 pull",
    });
    expect(actions.secondary.find((entry) => entry.id === "pr")).toMatchObject({
      label: "创建 PR",
      unavailableMessage: "无法创建 PR，因为此分支还没有新的 commit",
    });
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
        pullRequestGithub: oldDaemonStatus.forgeSpecific,
        shipDefault: "pr",
      }),
    );

    expect(oldDaemonStatus.forgeSpecific).toBeUndefined();
    expect(actions.primary).toMatchObject({
      id: "merge-pr-squash",
      label: "Merge PR (squash)",
    });
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
      "archive-workspace",
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
      label: "Auto merge (squash)",
    });
    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "enable-pr-auto-merge-squash",
      "archive-workspace",
    ]);
    expect(
      actions.secondary.some((action) =>
        ["merge-pr-squash", "merge-pr-merge", "merge-pr-rebase"].includes(action.id),
      ),
    ).toBe(false);
  });

  it.each([
    ["SQUASH", "enable-pr-auto-merge-squash", "Auto merge (squash)"],
    ["MERGE", "enable-pr-auto-merge-merge", "Auto merge (merge)"],
    ["REBASE", "enable-pr-auto-merge-rebase", "Auto merge (rebase)"],
  ] as const)(
    "labels the %s auto-merge action with its method",
    (viewerDefaultMergeMethod, id, label) => {
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
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerDefaultMergeMethod,
            },
          }),
          shipDefault: "pr",
        }),
      );

      expect(actions.primary).toMatchObject({ id, label });
    },
  );

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

    expect(actions.primary).toMatchObject({ id: "pr", label: "View PR" });
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
      label: "Merge PR (merge)",
    });
    expect(actions.secondary.map((action) => action.id)).toEqual([
      "pull",
      "push",
      "pull-and-push",
      "merge-from-base",
      "merge-branch",
      "pr",
      "merge-pr-merge",
      "archive-workspace",
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

    expect(groupStarters).toEqual(["merge-from-base", "merge-pr-squash", "archive-workspace"]);
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
