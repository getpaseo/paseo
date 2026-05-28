import type { ReactElement } from "react";

import type { ActionStatus } from "@/components/ui/dropdown-menu";
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
  aheadOfOrigin: number;
  behindOfOrigin: number;
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
  readonly label: string;
  readonly method: CheckoutPrMergeMethod;
  readonly startsGroup: boolean;
}

interface PullRequestAutoMergeEnableActionModel {
  readonly id: PullRequestAutoMergeEnableActionId;
  readonly role: "auto";
  readonly label: string;
  readonly method: CheckoutPrMergeMethod;
  readonly startsGroup: boolean;
}

const PULL_REQUEST_DIRECT_MERGE_ACTION_MODELS = [
  {
    id: "merge-pr-squash",
    role: "direct",
    label: "Squash and merge",
    method: "squash",
    startsGroup: true,
  },
  {
    id: "merge-pr-merge",
    role: "direct",
    label: "Create a merge commit",
    method: "merge",
    startsGroup: false,
  },
  {
    id: "merge-pr-rebase",
    role: "direct",
    label: "Rebase and merge",
    method: "rebase",
    startsGroup: false,
  },
] as const satisfies readonly PullRequestDirectMergeActionModel[];

const PULL_REQUEST_AUTO_MERGE_ENABLE_ACTION_MODELS = [
  {
    id: "enable-pr-auto-merge-squash",
    role: "auto",
    label: "Enable auto-merge with squash",
    method: "squash",
    startsGroup: true,
  },
  {
    id: "enable-pr-auto-merge-merge",
    role: "auto",
    label: "Enable auto-merge with merge commit",
    method: "merge",
    startsGroup: false,
  },
  {
    id: "enable-pr-auto-merge-rebase",
    role: "auto",
    label: "Enable auto-merge with rebase",
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

  for (const model of PULL_REQUEST_ACTION_MODELS) {
    allActions.set(model.id, model.build(input));
  }

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
  if (canPush(input)) {
    return "push";
  }
  if (!input.isOnBaseBranch && canMergeFromBase(input)) {
    return "merge-from-base";
  }
  if (canMergePr(input) && input.shipDefault === "pr") {
    return getDefaultDirectPullRequestMergeActionId(input);
  }
  if (canEnablePrAutoMerge(input) && input.shipDefault === "pr") {
    return getDefaultEnablePullRequestAutoMergeActionId(input);
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

function buildDirectPullRequestMergeAction(
  input: BuildGitActionsInput,
  model: PullRequestDirectMergeActionModel,
): GitAction {
  const runtime = input.runtime[model.id];
  const unavailableMessage = getMergePrUnavailableMessage(input);
  return {
    id: model.id,
    label: model.label,
    pendingLabel: "Merging PR...",
    successLabel: "PR merged",
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
    label: model.label,
    pendingLabel: "Enabling auto-merge...",
    successLabel: "Auto-merge enabled",
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
      : "Auto-merge is enabled, but this account can't disable it";
  return {
    id: "disable-pr-auto-merge",
    label: "Auto-merge enabled",
    pendingLabel: "Disabling auto-merge...",
    successLabel: "Auto-merge disabled",
    disabled: runtime.disabled || input.pullRequestGithub?.viewerCanDisableAutoMerge !== true,
    status: runtime.status,
    unavailableMessage: runtime.disabled ? undefined : unavailableMessage,
    icon: runtime.icon,
    startsGroup: true,
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
  if (!hasPullRequestGithubFacts(input.pullRequestGithub)) {
    return undefined;
  }
  if (input.pullRequestGithub?.isMergeQueueEnabled || input.pullRequestGithub?.isInMergeQueue) {
    return "Merge PR isn't available here because this repository uses a merge queue";
  }
  if (!GITHUB_DIRECT_MERGE_STATE_ALLOWLIST.has(input.pullRequestGithub?.mergeStateStatus ?? "")) {
    return "Merge PR isn't available until GitHub reports the pull request is ready to merge";
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
