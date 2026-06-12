import type { ReactElement } from "react";

import type { ActionStatus } from "@/components/ui/dropdown-menu";
import { i18n } from "@/i18n/i18next";
import type {
  CheckoutPrMergeMethod,
  CheckoutPrStatusResponse,
  PullRequestMergeable,
} from "@getpaseo/protocol/messages";

export type GitActionId =
  | "commit"
  | "pull"
  | "push"
  | "pull-and-push"
  | "pr"
  | "merge-pr-squash"
  | "merge-pr-merge"
  | "merge-pr-rebase"
  | "enable-pr-auto-merge-squash"
  | "enable-pr-auto-merge-merge"
  | "enable-pr-auto-merge-rebase"
  | "disable-pr-auto-merge"
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
  githubAutoMergeActionsEnabled: boolean;
  hasPullRequest: boolean;
  pullRequestUrl: string | null;
  pullRequestState: "open" | "closed" | null;
  pullRequestIsDraft: boolean;
  pullRequestIsMerged: boolean;
  pullRequestMergeable: PullRequestMergeable;
  pullRequestGithub: PullRequestGithubStatus | null;
  hasRemote: boolean;
  isPaseoOwnedWorktree: boolean;
  isOnBaseBranch: boolean;
  hasUncommittedChanges: boolean;
  baseRefAvailable: boolean;
  baseRefLabel: string;
  aheadCount: number;
  behindBaseCount: number;
  aheadOfOrigin: number | null;
  behindOfOrigin: number | null;
  shouldPromoteArchive: boolean;
  shipDefault: "merge" | "pr";
  runtime: Record<GitActionId, GitActionRuntimeState>;
}

type PullRequestActionId = Extract<
  GitActionId,
  | "pr"
  | "merge-pr-squash"
  | "merge-pr-merge"
  | "merge-pr-rebase"
  | "enable-pr-auto-merge-squash"
  | "enable-pr-auto-merge-merge"
  | "enable-pr-auto-merge-rebase"
  | "disable-pr-auto-merge"
>;
type PullRequestDirectMergeActionId = Extract<
  GitActionId,
  "merge-pr-squash" | "merge-pr-merge" | "merge-pr-rebase"
>;
type PullRequestAutoMergeEnableActionId = Extract<
  GitActionId,
  "enable-pr-auto-merge-squash" | "enable-pr-auto-merge-merge" | "enable-pr-auto-merge-rebase"
>;
type PullRequestActionRole = "status" | "direct" | "auto";
type PullRequestGithubStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>["github"];

interface PullRequestActionModel {
  readonly id: PullRequestActionId;
  readonly role: PullRequestActionRole;
  readonly build: (input: BuildGitActionsInput) => GitAction;
}

interface PullRequestDirectMergeActionModel {
  readonly id: PullRequestDirectMergeActionId;
  readonly role: "direct";
  readonly method: CheckoutPrMergeMethod;
  readonly startsGroup: boolean;
}

interface PullRequestAutoMergeEnableActionModel {
  readonly id: PullRequestAutoMergeEnableActionId;
  readonly role: "auto";
  readonly method: CheckoutPrMergeMethod;
  readonly startsGroup: boolean;
}

const PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS = [
  {
    id: "merge-pr-squash",
    role: "direct",
    method: "squash",
    startsGroup: true,
  },
  {
    id: "merge-pr-merge",
    role: "direct",
    method: "merge",
    startsGroup: false,
  },
  {
    id: "merge-pr-rebase",
    role: "direct",
    method: "rebase",
    startsGroup: false,
  },
] as const satisfies readonly PullRequestDirectMergeActionModel[];

const PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS = [
  {
    id: "enable-pr-auto-merge-squash",
    role: "auto",
    method: "squash",
    startsGroup: true,
  },
  {
    id: "enable-pr-auto-merge-merge",
    role: "auto",
    method: "merge",
    startsGroup: false,
  },
  {
    id: "enable-pr-auto-merge-rebase",
    role: "auto",
    method: "rebase",
    startsGroup: false,
  },
] as const satisfies readonly PullRequestAutoMergeEnableActionModel[];

const PULL_REQUEST_ACTION_MODELS: readonly PullRequestActionModel[] = [
  { id: "pr", role: "status", build: buildPrAction },
  ...PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS.map((model) => ({
    ...model,
    build: (input: BuildGitActionsInput) => buildDirectPullRequestMergeAction(input, model),
  })),
  ...PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS.map((model) => ({
    ...model,
    build: (input: BuildGitActionsInput) => buildEnablePullRequestAutoMergeAction(input, model),
  })),
  {
    id: "disable-pr-auto-merge",
    role: "auto",
    build: buildDisablePullRequestAutoMergeAction,
  },
];

const REMOTE_ACTION_IDS: GitActionId[] = ["pull", "push", "pull-and-push"];
const GITHUB_DIRECT_MERGE_STATE_ALLOWLIST = new Set(["CLEAN", "HAS_HOOKS"]);

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
    label: i18n.t("workspace.git.actions.commit.label"),
    pendingLabel: i18n.t("workspace.git.actions.commit.pending"),
    successLabel: i18n.t("workspace.git.actions.commit.success"),
    disabled: input.runtime.commit.disabled,
    status: input.runtime.commit.status,
    icon: input.runtime.commit.icon,
    startsGroup: false,
    handler: input.runtime.commit.handler,
  });

  allActions.set("pull", {
    id: "pull",
    label: i18n.t("workspace.git.actions.pull.label"),
    pendingLabel: i18n.t("workspace.git.actions.pull.pending"),
    successLabel: i18n.t("workspace.git.actions.pull.success"),
    disabled: input.runtime.pull.disabled,
    status: input.runtime.pull.status,
    unavailableMessage: input.runtime.pull.disabled ? undefined : getPullUnavailableMessage(input),
    icon: input.runtime.pull.icon,
    startsGroup: false,
    handler: input.runtime.pull.handler,
  });

  allActions.set("push", {
    id: "push",
    label: i18n.t("workspace.git.actions.push.label"),
    pendingLabel: i18n.t("workspace.git.actions.push.pending"),
    successLabel: i18n.t("workspace.git.actions.push.success"),
    disabled: input.runtime.push.disabled,
    status: input.runtime.push.status,
    unavailableMessage: input.runtime.push.disabled ? undefined : getPushUnavailableMessage(input),
    icon: input.runtime.push.icon,
    startsGroup: false,
    handler: input.runtime.push.handler,
  });

  allActions.set("pull-and-push", {
    id: "pull-and-push",
    label: i18n.t("workspace.git.actions.pullAndPush.label"),
    pendingLabel: i18n.t("workspace.git.actions.pullAndPush.pending"),
    successLabel: i18n.t("workspace.git.actions.pullAndPush.success"),
    disabled: input.runtime["pull-and-push"].disabled,
    status: input.runtime["pull-and-push"].status,
    unavailableMessage: input.runtime["pull-and-push"].disabled
      ? undefined
      : getPullAndPushUnavailableMessage(input),
    icon: input.runtime["pull-and-push"].icon,
    startsGroup: false,
    handler: input.runtime["pull-and-push"].handler,
  });

  for (const model of PULL_REQUEST_ACTION_MODELS) {
    allActions.set(model.id, model.build(input));
  }

  allActions.set("merge-branch", {
    id: "merge-branch",
    label: i18n.t("workspace.git.actions.mergeBranch.label"),
    pendingLabel: i18n.t("workspace.git.actions.mergeBranch.pending"),
    successLabel: i18n.t("workspace.git.actions.mergeBranch.success"),
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
    label: i18n.t("workspace.git.actions.mergeFromBase.label", { baseRef: input.baseRefLabel }),
    pendingLabel: i18n.t("workspace.git.actions.mergeFromBase.pending"),
    successLabel: i18n.t("workspace.git.actions.mergeFromBase.success"),
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
    label: i18n.t("workspace.git.actions.archive.label"),
    pendingLabel: i18n.t("workspace.git.actions.archive.pending"),
    successLabel: i18n.t("workspace.git.actions.archive.success"),
    disabled: input.runtime["archive-worktree"].disabled,
    status: input.runtime["archive-worktree"].status,
    unavailableMessage:
      input.runtime["archive-worktree"].disabled || input.isPaseoOwnedWorktree
        ? undefined
        : i18n.t("workspace.git.actions.unavailable.archiveNotWorktree"),
    icon: input.runtime["archive-worktree"].icon,
    startsGroup: true,
    handler: input.runtime["archive-worktree"].handler,
  });

  const primaryActionId = getPrimaryActionId(input);
  const primary = primaryActionId ? (allActions.get(primaryActionId) ?? null) : null;

  const secondaryIds = [...REMOTE_ACTION_IDS];
  if (!input.isOnBaseBranch) {
    secondaryIds.push(...getFeatureActionIds(input));
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
  if (canMergePr(input)) {
    return getDefaultDirectPullRequestMergeActionId(input);
  }
  if (canEnablePrAutoMerge(input)) {
    return getDefaultEnablePullRequestAutoMergeActionId(input);
  }
  if (hasEnabledPrAutoMerge(input)) {
    return "pr";
  }
  if (input.shipDefault === "pr" && canUsePullRequestActionAsShipDefault(input)) {
    return "pr";
  }
  if (canPush(input)) {
    return "push";
  }
  if (!input.isOnBaseBranch && input.aheadCount > 0) {
    return "merge-branch";
  }
  if (!input.isOnBaseBranch && canMergeFromBase(input)) {
    return "merge-from-base";
  }
  if (input.githubFeaturesEnabled && input.hasPullRequest && input.pullRequestUrl) {
    return "pr";
  }
  return null;
}

function getPullRequestActionIds(filter: {
  roles: readonly PullRequestActionRole[];
  input: BuildGitActionsInput;
}): PullRequestActionId[] {
  return PULL_REQUEST_ACTION_MODELS.filter((model) => filter.roles.includes(model.role))
    .filter((model) => shouldShowPullRequestAction(filter.input, model.id))
    .map((model) => model.id);
}

function getFeatureActionIds(input: BuildGitActionsInput): GitActionId[] {
  return [
    "merge-from-base",
    "merge-branch",
    ...getPullRequestActionIds({ roles: ["status", "direct", "auto"], input }),
  ];
}

function getDefaultDirectPullRequestMergeActionId(
  input: BuildGitActionsInput,
): PullRequestDirectMergeActionId {
  return (
    getPreferredDirectPullRequestMergeActionModel(input)?.id ??
    PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS[0].id
  );
}

function getDefaultEnablePullRequestAutoMergeActionId(
  input: BuildGitActionsInput,
): PullRequestAutoMergeEnableActionId {
  return (
    getPreferredEnablePullRequestAutoMergeActionModel(input)?.id ??
    PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS[0].id
  );
}

function buildPrAction(input: BuildGitActionsInput): GitAction {
  if (input.hasPullRequest && input.pullRequestUrl) {
    return {
      id: "pr",
      label: i18n.t("workspace.git.actions.viewPr"),
      pendingLabel: i18n.t("workspace.git.actions.viewPr"),
      successLabel: i18n.t("workspace.git.actions.viewPr"),
      disabled: input.runtime.pr.disabled,
      status: input.runtime.pr.status,
      unavailableMessage:
        input.runtime.pr.disabled || input.githubFeaturesEnabled
          ? undefined
          : i18n.t("workspace.git.actions.unavailable.viewPrNoGithub"),
      icon: input.runtime.pr.icon,
      startsGroup: false,
      handler: input.runtime.pr.handler,
    };
  }

  return {
    id: "pr",
    label: i18n.t("workspace.git.actions.createPr.label"),
    pendingLabel: i18n.t("workspace.git.actions.createPr.pending"),
    successLabel: i18n.t("workspace.git.actions.createPr.success"),
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

function buildDirectPullRequestMergeAction(
  input: BuildGitActionsInput,
  model: PullRequestDirectMergeActionModel,
): GitAction {
  const runtime = input.runtime[model.id];
  const unavailableMessage = getMergePrUnavailableMessage(input);
  return {
    id: model.id,
    label: getDirectPullRequestMergeActionLabel(model.id),
    pendingLabel: i18n.t("workspace.git.actions.mergePr.pending"),
    successLabel: i18n.t("workspace.git.actions.mergePr.success"),
    disabled: runtime.disabled || shouldDisableMergePrAction(input),
    status: runtime.status,
    unavailableMessage: runtime.disabled ? undefined : unavailableMessage,
    icon: runtime.icon,
    startsGroup: model.startsGroup,
    handler: runtime.handler,
  };
}

function buildEnablePullRequestAutoMergeAction(
  input: BuildGitActionsInput,
  model: PullRequestAutoMergeEnableActionModel,
): GitAction {
  const runtime = input.runtime[model.id];
  return {
    id: model.id,
    label: getEnablePullRequestAutoMergeActionLabel(model.id),
    pendingLabel: i18n.t("workspace.git.actions.autoMerge.enabling"),
    successLabel: i18n.t("workspace.git.actions.autoMerge.enabled"),
    disabled: runtime.disabled,
    status: runtime.status,
    icon: runtime.icon,
    startsGroup: model.startsGroup,
    handler: runtime.handler,
  };
}

function buildDisablePullRequestAutoMergeAction(input: BuildGitActionsInput): GitAction {
  const runtime = input.runtime["disable-pr-auto-merge"];
  const unavailableMessage =
    input.pullRequestGithub?.viewerCanDisableAutoMerge === true
      ? undefined
      : i18n.t("workspace.git.actions.unavailable.autoMergeCannotDisable");
  return {
    id: "disable-pr-auto-merge",
    label: i18n.t("workspace.git.actions.autoMerge.enabled"),
    pendingLabel: i18n.t("workspace.git.actions.autoMerge.disabling"),
    successLabel: i18n.t("workspace.git.actions.autoMerge.disabled"),
    disabled: runtime.disabled || input.pullRequestGithub?.viewerCanDisableAutoMerge !== true,
    status: runtime.status,
    unavailableMessage: runtime.disabled ? undefined : unavailableMessage,
    icon: runtime.icon,
    startsGroup: true,
    handler: runtime.handler,
  };
}

function getDirectPullRequestMergeActionLabel(id: PullRequestDirectMergeActionId): string {
  switch (id) {
    case "merge-pr-squash":
      return i18n.t("workspace.git.actions.mergePr.squash");
    case "merge-pr-merge":
      return i18n.t("workspace.git.actions.mergePr.merge");
    case "merge-pr-rebase":
      return i18n.t("workspace.git.actions.mergePr.rebase");
  }
}

function getEnablePullRequestAutoMergeActionLabel(id: PullRequestAutoMergeEnableActionId): string {
  switch (id) {
    case "enable-pr-auto-merge-squash":
      return i18n.t("workspace.git.actions.autoMerge.enableSquash");
    case "enable-pr-auto-merge-merge":
      return i18n.t("workspace.git.actions.autoMerge.enableMerge");
    case "enable-pr-auto-merge-rebase":
      return i18n.t("workspace.git.actions.autoMerge.enableRebase");
  }
}

function canPull(input: BuildGitActionsInput): boolean {
  return input.hasRemote && !input.hasUncommittedChanges && (input.behindOfOrigin ?? 0) > 0;
}

function canPush(input: BuildGitActionsInput): boolean {
  return input.hasRemote && hasPushableCommits(input) && (input.behindOfOrigin ?? 0) === 0;
}

function hasPushableCommits(input: BuildGitActionsInput): boolean {
  if ((input.aheadOfOrigin ?? 0) > 0) {
    return true;
  }
  // No-upstream Paseo worktrees are first-pushable: the daemon push sets upstream with `git push -u`.
  // Do not fold this into aheadOfOrigin; null also covers deleted/pruned upstream branches.
  return input.isPaseoOwnedWorktree && input.aheadOfOrigin === null && input.aheadCount > 0;
}

function canMergeFromBase(input: BuildGitActionsInput): boolean {
  return (
    !input.isOnBaseBranch &&
    input.baseRefAvailable &&
    !input.hasUncommittedChanges &&
    input.behindBaseCount > 0
  );
}

function canUsePullRequestActionAsShipDefault(input: BuildGitActionsInput): boolean {
  if (input.isOnBaseBranch || !input.githubFeaturesEnabled) {
    return false;
  }
  if (input.hasPullRequest) {
    return input.pullRequestUrl !== null;
  }
  return input.aheadCount > 0;
}

function canMergePr(input: BuildGitActionsInput): boolean {
  const github = input.pullRequestGithub;
  const canMergeFromPullRequestStatus =
    input.githubFeaturesEnabled &&
    input.hasPullRequest &&
    input.pullRequestState === "open" &&
    !input.pullRequestIsDraft &&
    !input.pullRequestIsMerged &&
    input.pullRequestMergeable !== "CONFLICTING" &&
    input.aheadCount > 0 &&
    !input.hasUncommittedChanges;

  if (!canMergeFromPullRequestStatus) {
    return false;
  }

  if (!hasPullRequestGithubFacts(github)) {
    return (
      input.pullRequestMergeable === "MERGEABLE" &&
      input.behindOfOrigin === 0 &&
      input.aheadOfOrigin === 0 &&
      !canMergeFromBase(input)
    );
  }

  return (
    GITHUB_DIRECT_MERGE_STATE_ALLOWLIST.has(github.mergeStateStatus ?? "") &&
    github.autoMergeRequest === null &&
    !github.isMergeQueueEnabled &&
    !github.isInMergeQueue &&
    getAllowedDirectPullRequestMergeActionModels(input).length > 0
  );
}

function canEnablePrAutoMerge(input: BuildGitActionsInput): boolean {
  const github = input.pullRequestGithub;
  return (
    input.githubFeaturesEnabled &&
    input.githubAutoMergeActionsEnabled &&
    input.hasPullRequest &&
    input.pullRequestState === "open" &&
    !input.pullRequestIsDraft &&
    !input.pullRequestIsMerged &&
    input.pullRequestMergeable !== "CONFLICTING" &&
    hasPullRequestGithubFacts(github) &&
    github.autoMergeRequest === null &&
    github.mergeStateStatus === "BLOCKED" &&
    github.repository.autoMergeAllowed &&
    github.viewerCanEnableAutoMerge &&
    !github.isMergeQueueEnabled &&
    !github.isInMergeQueue &&
    getAllowedAutoMergeEnableActionModels(input).length > 0
  );
}

function hasEnabledPrAutoMerge(input: BuildGitActionsInput): boolean {
  return (
    input.githubFeaturesEnabled &&
    input.hasPullRequest &&
    input.pullRequestUrl !== null &&
    hasPullRequestGithubFacts(input.pullRequestGithub) &&
    input.pullRequestGithub.autoMergeRequest !== null
  );
}

function getPullUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return i18n.t("workspace.git.actions.unavailable.pullNoRemote");
  }
  if (input.hasUncommittedChanges) {
    return i18n.t("workspace.git.actions.unavailable.pullDirty");
  }
  if (input.behindOfOrigin === null) {
    return "Pull isn't available here because this branch is not connected to a remote yet";
  }
  if (input.behindOfOrigin === 0) {
    return i18n.t("workspace.git.actions.unavailable.pullUpToDate");
  }
  return undefined;
}

function getPushUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return i18n.t("workspace.git.actions.unavailable.pushNoRemote");
  }
  if ((input.behindOfOrigin ?? 0) > 0) {
    return i18n.t("workspace.git.actions.unavailable.pushBehind");
  }
  if (!hasPushableCommits(input)) {
    return i18n.t("workspace.git.actions.unavailable.pushNothing");
  }
  return undefined;
}

function getPullAndPushUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.hasRemote) {
    return i18n.t("workspace.git.actions.unavailable.pullAndPushNoRemote");
  }
  if (input.hasUncommittedChanges) {
    return i18n.t("workspace.git.actions.unavailable.pullAndPushDirty");
  }
  if (input.behindOfOrigin === null) {
    return "Pull and push isn't available because there are no incoming changes to pull first";
  }
  if (input.behindOfOrigin === 0 && input.aheadOfOrigin === 0) {
    return i18n.t("workspace.git.actions.unavailable.pullAndPushInSync");
  }
  if (input.behindOfOrigin === 0) {
    return "Pull and push isn't available because there are no incoming changes to pull first";
  }
  if ((input.aheadOfOrigin ?? 0) === 0) {
    return "Pull and push isn't available because there is nothing new to send after pulling";
  }
  return undefined;
}

function getCreatePrUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.githubFeaturesEnabled) {
    return i18n.t("workspace.git.actions.unavailable.createPrNoGithub");
  }
  if (input.aheadCount === 0) {
    return i18n.t("workspace.git.actions.unavailable.createPrNoCommits");
  }
  return undefined;
}

function getMergeBranchUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.baseRefAvailable) {
    return i18n.t("workspace.git.actions.unavailable.mergeNoBase");
  }
  if (input.hasUncommittedChanges) {
    return i18n.t("workspace.git.actions.unavailable.mergeDirty");
  }
  if (input.aheadCount === 0) {
    return i18n.t("workspace.git.actions.unavailable.mergeNothing");
  }
  return undefined;
}

function getMergeFromBaseUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.baseRefAvailable) {
    return i18n.t("workspace.git.actions.unavailable.updateNoBase");
  }
  if (input.hasUncommittedChanges) {
    return i18n.t("workspace.git.actions.unavailable.updateDirty");
  }
  if (input.behindBaseCount === 0) {
    return i18n.t("workspace.git.actions.unavailable.updateCurrent", {
      baseRef: input.baseRefLabel,
    });
  }
  return undefined;
}

function getMergePrUnavailableMessage(input: BuildGitActionsInput): string | undefined {
  if (!input.githubFeaturesEnabled) {
    return i18n.t("workspace.git.actions.unavailable.mergePrNoGithub");
  }
  if (!input.hasPullRequest) {
    return i18n.t("workspace.git.actions.unavailable.mergePrMissing");
  }
  if (input.pullRequestIsDraft) {
    return i18n.t("workspace.git.actions.unavailable.mergePrDraft");
  }
  if (input.pullRequestIsMerged) {
    return i18n.t("workspace.git.actions.unavailable.mergePrMerged");
  }
  if (input.pullRequestState === "closed") {
    return i18n.t("workspace.git.actions.unavailable.mergePrClosed");
  }
  if (input.pullRequestMergeable === "CONFLICTING") {
    return i18n.t("workspace.git.actions.unavailable.mergePrConflicts");
  }
  if (!hasPullRequestGithubFacts(input.pullRequestGithub)) {
    return undefined;
  }
  if (input.pullRequestGithub?.isMergeQueueEnabled || input.pullRequestGithub?.isInMergeQueue) {
    return i18n.t("workspace.git.actions.unavailable.mergePrQueue");
  }
  if (!GITHUB_DIRECT_MERGE_STATE_ALLOWLIST.has(input.pullRequestGithub?.mergeStateStatus ?? "")) {
    return i18n.t("workspace.git.actions.unavailable.mergePrNotReady");
  }
  return undefined;
}

function shouldDisableMergePrAction(input: BuildGitActionsInput): boolean {
  return !canMergePr(input);
}

function shouldShowPullRequestAction(
  input: BuildGitActionsInput,
  id: PullRequestActionId,
): boolean {
  if (id === "pr") {
    return true;
  }
  if (id === "disable-pr-auto-merge") {
    return (
      input.githubAutoMergeActionsEnabled &&
      hasPullRequestGithubFacts(input.pullRequestGithub) &&
      input.pullRequestGithub.autoMergeRequest !== null
    );
  }
  if (isDirectPullRequestMergeActionId(id)) {
    return canMergePr(input) && getAllowedDirectPullRequestMergeActionIds(input).includes(id);
  }
  if (isEnablePullRequestAutoMergeActionId(id)) {
    return canEnablePrAutoMerge(input) && getAllowedAutoMergeEnableActionIds(input).includes(id);
  }
  return false;
}

function isDirectPullRequestMergeActionId(
  id: PullRequestActionId,
): id is PullRequestDirectMergeActionId {
  return PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS.some((model) => model.id === id);
}

function isEnablePullRequestAutoMergeActionId(
  id: PullRequestActionId,
): id is PullRequestAutoMergeEnableActionId {
  return PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS.some((model) => model.id === id);
}

function getAllowedDirectPullRequestMergeActionIds(
  input: BuildGitActionsInput,
): PullRequestDirectMergeActionId[] {
  return getAllowedDirectPullRequestMergeActionModels(input).map((model) => model.id);
}

function getAllowedAutoMergeEnableActionIds(
  input: BuildGitActionsInput,
): PullRequestAutoMergeEnableActionId[] {
  return getAllowedAutoMergeEnableActionModels(input).map((model) => model.id);
}

function getAllowedDirectPullRequestMergeActionModels(
  input: BuildGitActionsInput,
): readonly PullRequestDirectMergeActionModel[] {
  return PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS.filter((model) =>
    isPullRequestMergeMethodAllowed(input, model.method),
  );
}

function getAllowedAutoMergeEnableActionModels(
  input: BuildGitActionsInput,
): readonly PullRequestAutoMergeEnableActionModel[] {
  return PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS.filter((model) =>
    isPullRequestMergeMethodAllowed(input, model.method),
  );
}

function getPreferredDirectPullRequestMergeActionModel(
  input: BuildGitActionsInput,
): PullRequestDirectMergeActionModel | null {
  const allowed = getAllowedDirectPullRequestMergeActionModels(input);
  const preferred = normalizeGithubMergeMethod(
    input.pullRequestGithub?.repository.viewerDefaultMergeMethod ?? null,
  );
  return allowed.find((model) => model.method === preferred) ?? allowed[0] ?? null;
}

function getPreferredEnablePullRequestAutoMergeActionModel(
  input: BuildGitActionsInput,
): PullRequestAutoMergeEnableActionModel | null {
  const allowed = getAllowedAutoMergeEnableActionModels(input);
  const preferred = normalizeGithubMergeMethod(
    input.pullRequestGithub?.repository.viewerDefaultMergeMethod ?? null,
  );
  return allowed.find((model) => model.method === preferred) ?? allowed[0] ?? null;
}

function isPullRequestMergeMethodAllowed(
  input: BuildGitActionsInput,
  method: CheckoutPrMergeMethod,
): boolean {
  const repository = input.pullRequestGithub?.repository;
  if (!repository) {
    return true;
  }
  if (method === "squash") {
    return repository.squashMergeAllowed;
  }
  if (method === "merge") {
    return repository.mergeCommitAllowed;
  }
  return repository.rebaseMergeAllowed;
}

function hasPullRequestGithubFacts(
  github: PullRequestGithubStatus | null,
): github is NonNullable<PullRequestGithubStatus> {
  return github !== null && github !== undefined;
}

function normalizeGithubMergeMethod(value: string | null): CheckoutPrMergeMethod | null {
  if (value === "SQUASH") return "squash";
  if (value === "MERGE") return "merge";
  if (value === "REBASE") return "rebase";
  return null;
}
