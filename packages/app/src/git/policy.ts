import type { ReactElement } from "react";

import type { ActionStatus } from "@/components/ui/dropdown-menu";
import type { CheckoutPrMergeMethod, PullRequestMergeable } from "@server/shared/messages";

export type GitActionId =
  | "commit"
  | "pull"
  | "push"
  | "pull-and-push"
  | "pr"
  | "merge-pr-squash"
  | "merge-pr-merge"
  | "merge-pr-rebase"
  | "merge-branch"
  | "merge-from-base"
  | "archive-worktree";

export interface GitAction {
  id: GitActionId;
  label: string;
  pendingLabel: string;
  successLabel: string;
  disabled: boolean;
  status: ActionStatus;
  unavailableMessage?: string;
  icon?: ReactElement;
  /** When true, a menu separator should be rendered before this item. */
  startsGroup: boolean;
  handler: () => void;
}

export interface GitActions {
  primary: GitAction | null;
  secondary: GitAction[];
  menu: GitAction[];
}

interface GitActionRuntimeState {
  disabled: boolean;
  status: ActionStatus;
  icon?: ReactElement;
  handler: () => void;
}

export interface BuildGitActionsInput {
  isGit: boolean;
  githubFeaturesEnabled: boolean;
  hasPullRequest: boolean;
  pullRequestUrl: string | null;
  pullRequestState: "open" | "closed" | null;
  pullRequestIsDraft: boolean;
  pullRequestIsMerged: boolean;
  pullRequestMergeable: PullRequestMergeable;
  hasRemote: boolean;
  isPaseoOwnedWorktree: boolean;
  isOnBaseBranch: boolean;
  hasUncommittedChanges: boolean;
  baseRefAvailable: boolean;
  baseRefLabel: string;
  aheadCount: number;
  behindBaseCount: number;
  aheadOfOrigin: number;
  behindOfOrigin: number;
  shouldPromoteArchive: boolean;
  shipDefault: "merge" | "pr";
  runtime: Record<GitActionId, GitActionRuntimeState>;
}

const REMOTE_ACTION_IDS: GitActionId[] = ["pull", "push", "pull-and-push"];
const FEATURE_ACTION_IDS: GitActionId[] = [
  "merge-from-base",
  "merge-branch",
  "pr",
  "merge-pr-squash",
  "merge-pr-merge",
  "merge-pr-rebase",
];

const MERGE_PR_METHODS: Record<
  "merge-pr-squash" | "merge-pr-merge" | "merge-pr-rebase",
  { label: string; method: CheckoutPrMergeMethod }
> = {
  "merge-pr-squash": { label: "Squash and merge", method: "squash" },
  "merge-pr-merge": { label: "Create a merge commit", method: "merge" },
  "merge-pr-rebase": { label: "Rebase and merge", method: "rebase" },
};

export function narrowPullRequestState(state: string | null | undefined): "open" | "closed" | null {
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return null;
}

export function buildGitActions(input: BuildGitActionsInput): GitActions {
  if (!input.isGit) {
    return { primary: null, secondary: [], menu: [] };
  }

  const allActions = new Map<GitActionId, GitAction>();

  allActions.set("commit", {
    id: "commit",
    label: "Commit",
    pendingLabel: "Committing...",
    successLabel: "Committed",
    disabled: input.runtime.commit.disabled,
    status: input.runtime.commit.status,
    icon: input.runtime.commit.icon,
    startsGroup: false,
    handler: input.runtime.commit.handler,
  });

  allActions.set("pull", {
    id: "pull",
    label: "Pull",
    pendingLabel: "Pulling...",
    successLabel: "Pulled",
    disabled: input.runtime.pull.disabled,
    status: input.runtime.pull.status,
    unavailableMessage: input.runtime.pull.disabled ? undefined : getPullUnavailableMessage(input),
    icon: input.runtime.pull.icon,
    startsGroup: false,
    handler: input.runtime.pull.handler,
  });

  allActions.set("push", {
    id: "push",
    label: "Push",
    pendingLabel: "Pushing...",
    successLabel: "Pushed",
    disabled: input.runtime.push.disabled,
    status: input.runtime.push.status,
    unavailableMessage: input.runtime.push.disabled ? undefined : getPushUnavailableMessage(input),
    icon: input.runtime.push.icon,
    startsGroup: false,
    handler: input.runtime.push.handler,
  });

  allActions.set("pull-and-push", {
    id: "pull-and-push",
    label: "Pull and push",
    pendingLabel: "Pulling and pushing...",
    successLabel: "Pulled and pushed",
    disabled: input.runtime["pull-and-push"].disabled,
    status: input.runtime["pull-and-push"].status,
    unavailableMessage: input.runtime["pull-and-push"].disabled
      ? undefined
      : getPullAndPushUnavailableMessage(input),
    icon: input.runtime["pull-and-push"].icon,
    startsGroup: false,
    handler: input.runtime["pull-and-push"].handler,
  });

  allActions.set("pr", buildPrAction(input));

  allActions.set("merge-pr-squash", buildMergePrAction(input, "merge-pr-squash"));
  allActions.set("merge-pr-merge", buildMergePrAction(input, "merge-pr-merge"));
  allActions.set("merge-pr-rebase", buildMergePrAction(input, "merge-pr-rebase"));

  allActions.set("merge-branch", {
    id: "merge-branch",
    label: "Merge locally",
    pendingLabel: "Merging...",
    successLabel: "Merged",
    disabled: input.runtime["merge-branch"].disabled,
    status: input.runtime["merge-branch"].status,
    unavailableMessage: input.runtime["merge-branch"].disabled
      ? undefined
      : getMergeBranchUnavailableMessage(input),
    icon: input.runtime["merge-branch"].icon,
    startsGroup: false,
    handler: input.runtime["merge-branch"].handler,
  });

  allActions.set("merge-from-base", {
    id: "merge-from-base",
    label: `Update from ${input.baseRefLabel}`,
    pendingLabel: "Updating...",
    successLabel: "Updated",
    disabled: input.runtime["merge-from-base"].disabled,
    status: input.runtime["merge-from-base"].status,
    unavailableMessage: input.runtime["merge-from-base"].disabled
      ? undefined
      : getMergeFromBaseUnavailableMessage(input),
    icon: input.runtime["merge-from-base"].icon,
    startsGroup: true,
    handler: input.runtime["merge-from-base"].handler,
  });

  allActions.set("archive-worktree", {
    id: "archive-worktree",
    label: "Archive worktree",
    pendingLabel: "Archiving...",
    successLabel: "Archived",
    disabled: input.runtime["archive-worktree"].disabled,
    status: input.runtime["archive-worktree"].status,
    unavailableMessage:
      input.runtime["archive-worktree"].disabled || input.isPaseoOwnedWorktree
        ? undefined
        : "Archive isn't available here because this workspace was not created as a Paseo worktree",
    icon: input.runtime["archive-worktree"].icon,
    startsGroup: true,
    handler: input.runtime["archive-worktree"].handler,
  });

  const primaryActionId = getPrimaryActionId(input);
  const primary = primaryActionId ? (allActions.get(primaryActionId) ?? null) : null;

  const secondaryIds = [...REMOTE_ACTION_IDS];
  if (!input.isOnBaseBranch) {
    secondaryIds.push(...FEATURE_ACTION_IDS);
  }
  if (input.isPaseoOwnedWorktree) {
    secondaryIds.push("archive-worktree");
  }

  return {
    primary,
    secondary: secondaryIds.map((id) => allActions.get(id)!),
    menu: [],
  };
}

function getPrimaryActionId(input: BuildGitActionsInput): GitActionId | null {
  if (input.shouldPromoteArchive && input.isPaseoOwnedWorktree) {
    return "archive-worktree";
  }
  if (input.hasUncommittedChanges) {
    return "commit";
  }
  if (canPull(input)) {
    return "pull";
  }
  if (canPush(input)) {
    return "push";
  }
  if (!input.isOnBaseBranch && canMergeFromBase(input)) {
    return "merge-from-base";
  }
  if (canMergePr(input) && input.shipDefault === "pr") {
    return "merge-pr-squash";
  }
  if (!input.isOnBaseBranch && input.aheadCount > 0 && input.shipDefault === "merge") {
    return "merge-branch";
  }
  if (input.githubFeaturesEnabled && input.hasPullRequest && input.pullRequestUrl) {
    return "pr";
  }
  if (!input.isOnBaseBranch && input.aheadCount > 0) {
    return "pr";
  }
  return null;
}

function buildPrAction(input: BuildGitActionsInput): GitAction {
  if (input.hasPullRequest && input.pullRequestUrl) {
    return {
      id: "pr",
      label: "View PR",
      pendingLabel: "View PR",
      successLabel: "View PR",
      disabled: input.runtime.pr.disabled,
      status: input.runtime.pr.status,
      unavailableMessage:
        input.runtime.pr.disabled || input.githubFeaturesEnabled
          ? undefined
          : "View PR isn't available right now because GitHub isn't connected",
      icon: input.runtime.pr.icon,
      startsGroup: false,
      handler: input.runtime.pr.handler,
    };
  }

  return {
    id: "pr",
    label: "Create PR",
    pendingLabel: "Creating PR...",
    successLabel: "PR Created",
    disabled: input.runtime.pr.disabled,
    status: input.runtime.pr.status,
    unavailableMessage: input.runtime.pr.disabled
      ? undefined
      : getCreatePrUnavailableMessage(input),
    icon: input.runtime.pr.icon,
    startsGroup: false,
    handler: input.runtime.pr.handler,
  };
}

function buildMergePrAction(
  input: BuildGitActionsInput,
  id: "merge-pr-squash" | "merge-pr-merge" | "merge-pr-rebase",
): GitAction {
  const runtime = input.runtime[id];
  const config = MERGE_PR_METHODS[id];
  const unavailableMessage = getMergePrUnavailableMessage(input);
  return {
    id,
    label: config.label,
    pendingLabel: "Merging PR...",
    successLabel: "PR merged",
    disabled: runtime.disabled || shouldDisableMergePrAction(input),
    status: runtime.status,
    unavailableMessage: runtime.disabled ? undefined : unavailableMessage,
    icon: runtime.icon,
    startsGroup: id === "merge-pr-squash",
    handler: runtime.handler,
  };
}

function canPull(input: BuildGitActionsInput): boolean {
  return input.hasRemote && !input.hasUncommittedChanges && input.behindOfOrigin > 0;
}

function canPush(input: BuildGitActionsInput): boolean {
  return input.hasRemote && input.aheadOfOrigin > 0 && input.behindOfOrigin === 0;
}

function canMergeFromBase(input: BuildGitActionsInput): boolean {
  return (
    !input.isOnBaseBranch &&
    input.baseRefAvailable &&
    !input.hasUncommittedChanges &&
    input.behindBaseCount > 0
  );
}

function canMergePr(input: BuildGitActionsInput): boolean {
  return (
    input.githubFeaturesEnabled &&
    input.hasPullRequest &&
    input.pullRequestState === "open" &&
    !input.pullRequestIsDraft &&
    !input.pullRequestIsMerged &&
    input.pullRequestMergeable === "MERGEABLE" &&
    input.aheadCount > 0 &&
    !input.hasUncommittedChanges &&
    input.behindOfOrigin === 0 &&
    input.aheadOfOrigin === 0 &&
    !canMergeFromBase(input)
  );
}

function getPullUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return "Pull isn't available here because this branch is not connected to a remote yet";
  }
  if (input.hasUncommittedChanges) {
    return "Pull isn't available while you have local changes so commit or stash them first";
  }
  if (input.behindOfOrigin === 0) {
    return "Pull isn't available because this branch is already up to date";
  }
  return undefined;
}

function getPushUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return "Push isn't available here because this branch is not connected to a remote yet";
  }
  if (input.behindOfOrigin > 0) {
    return "Push isn't available yet because there are newer changes to bring in first";
  }
  if (input.aheadOfOrigin === 0) {
    return "Push isn't available because there is nothing new to send";
  }
  return undefined;
}

function getPullAndPushUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return "Pull and push isn't available here because this branch is not connected to a remote yet";
  }
  if (input.hasUncommittedChanges) {
    return "Pull and push isn't available while you have local changes so commit or stash them first";
  }
  if (input.behindOfOrigin === 0 && input.aheadOfOrigin === 0) {
    return "Pull and push isn't available because this branch is already in sync";
  }
  return undefined;
}

function getCreatePrUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.githubFeaturesEnabled) {
    return "Create PR isn't available right now because GitHub isn't connected";
  }
  if (input.aheadCount === 0) {
    return "Create PR isn't available because this branch doesn't have any new commits yet";
  }
  return undefined;
}

function getMergeBranchUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.baseRefAvailable) {
    return "Merge isn't available because we couldn't determine the base branch";
  }
  if (input.hasUncommittedChanges) {
    return "Merge isn't available while you have local changes so commit or stash them first";
  }
  if (input.aheadCount === 0) {
    return "Merge isn't available because this branch doesn't have anything new to merge yet";
  }
  return undefined;
}

function getMergeFromBaseUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.baseRefAvailable) {
    return "Update isn't available because we couldn't determine the base branch";
  }
  if (input.hasUncommittedChanges) {
    return "Update isn't available while you have local changes so commit or stash them first";
  }
  if (input.behindBaseCount === 0) {
    return `Update isn't available because this branch is already up to date with ${input.baseRefLabel}`;
  }
  return undefined;
}

function getMergePrUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.githubFeaturesEnabled) {
    return "Merge PR isn't available right now because GitHub isn't connected";
  }
  if (!input.hasPullRequest) {
    return "Merge PR isn't available because there isn't a pull request yet";
  }
  if (input.pullRequestIsDraft) {
    return "Merge PR isn't available because the pull request is still a draft";
  }
  if (input.pullRequestIsMerged) {
    return "Merge PR isn't available because the pull request is already merged";
  }
  if (input.pullRequestState === "closed") {
    return "Merge PR isn't available because the pull request is closed";
  }
  if (input.pullRequestMergeable === "CONFLICTING") {
    return "Merge PR isn't available because the pull request has conflicts";
  }
  return undefined;
}

function shouldDisableMergePrAction(input: BuildGitActionsInput): boolean {
  return (
    input.pullRequestIsDraft ||
    input.pullRequestIsMerged ||
    input.pullRequestState === "closed" ||
    input.pullRequestMergeable === "CONFLICTING"
  );
}
