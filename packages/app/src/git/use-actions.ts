import { useState, useCallback, useEffect, useMemo, type ReactElement } from "react";
import { router, type Href } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type CheckoutGitActionStatus, useCheckoutGitActionsStore } from "@/git/actions-store";
import { type CheckoutStatusPayload, useCheckoutStatusQuery } from "@/git/use-status-query";
import { type CheckoutPrStatusPayload, useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { buildGitActions, narrowPullRequestState, type GitActions } from "@/git/policy";
import type { CheckoutPrMergeMethod } from "@server/shared/messages";
import { openExternalUrl } from "@/utils/open-external-url";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export type { GitActionId, GitAction, GitActions } from "@/git/policy";

function openURLInNewTab(url: string): void {
  void openExternalUrl(url);
}

function isActionDisabled(actionsDisabled: boolean, status: CheckoutGitActionStatus): boolean {
  return actionsDisabled || status === "pending";
}

function resolveBranchLabel(input: {
  currentBranch: string | null | undefined;
  notGit: boolean;
}): string {
  if (input.currentBranch && input.currentBranch !== "HEAD") {
    return input.currentBranch;
  }
  if (input.notGit) {
    return "Not a git repository";
  }
  return "Unknown";
}

function formatBaseRefLabel(baseRef: string | undefined): string {
  if (!baseRef) return "base";
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

type PrStatusValue = NonNullable<CheckoutPrStatusPayload["status"]> | null;

interface DeriveGitActionsStateArgs {
  isGit: boolean;
  status: CheckoutStatusPayload | null;
  gitStatus: CheckoutStatusPayload | null;
  prStatus: PrStatusValue;
  hasUncommittedChanges: boolean;
  postShipArchiveSuggested: boolean;
  isStatusLoading: boolean;
  baseRefLabel: string;
}

interface DerivedGitActionsState {
  actionsDisabled: boolean;
  aheadCount: number;
  behindBaseCount: number;
  aheadOfOrigin: number;
  behindOfOrigin: number;
  hasPullRequest: boolean;
  hasRemote: boolean;
  isPaseoOwnedWorktree: boolean;
  isOnBaseBranch: boolean;
  shouldPromoteArchive: boolean;
}

interface GitCommitCounts {
  aheadCount: number;
  behindBaseCount: number;
  aheadOfOrigin: number;
  behindOfOrigin: number;
}

function extractGitCommitCounts(gitStatus: CheckoutStatusPayload | null): GitCommitCounts {
  return {
    aheadCount: gitStatus?.aheadBehind?.ahead ?? 0,
    behindBaseCount: gitStatus?.aheadBehind?.behind ?? 0,
    aheadOfOrigin: gitStatus?.aheadOfOrigin ?? 0,
    behindOfOrigin: gitStatus?.behindOfOrigin ?? 0,
  };
}

function computeShouldPromoteArchive(input: {
  isPaseoOwnedWorktree: boolean;
  hasUncommittedChanges: boolean;
  postShipArchiveSuggested: boolean;
  isMergedPullRequest: boolean;
}): boolean {
  return (
    input.isPaseoOwnedWorktree &&
    !input.hasUncommittedChanges &&
    (input.postShipArchiveSuggested || input.isMergedPullRequest)
  );
}

function deriveGitActionsState(args: DeriveGitActionsStateArgs): DerivedGitActionsState {
  const {
    isGit,
    status,
    gitStatus,
    prStatus,
    hasUncommittedChanges,
    postShipArchiveSuggested,
    isStatusLoading,
    baseRefLabel,
  } = args;
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  const isPaseoOwnedWorktree = gitStatus?.isPaseoOwnedWorktree ?? false;
  const isMergedPullRequest = Boolean(prStatus?.isMerged);
  return {
    actionsDisabled,
    ...extractGitCommitCounts(gitStatus),
    hasPullRequest: Boolean(prStatus?.url),
    hasRemote: gitStatus?.hasRemote ?? false,
    isPaseoOwnedWorktree,
    isOnBaseBranch: gitStatus?.currentBranch === baseRefLabel,
    shouldPromoteArchive: computeShouldPromoteArchive({
      isPaseoOwnedWorktree,
      hasUncommittedChanges,
      postShipArchiveSuggested,
      isMergedPullRequest,
    }),
  };
}

interface UseGitActionsInput {
  serverId: string;
  cwd: string;
  icons: {
    commit: ReactElement;
    pull: ReactElement;
    push: ReactElement;
    pullAndPush: ReactElement;
    viewPr: ReactElement;
    createPr: ReactElement;
    mergePrSquash: ReactElement;
    mergePrMerge: ReactElement;
    mergePrRebase: ReactElement;
    merge: ReactElement;
    mergeFromBase: ReactElement;
    archive: ReactElement;
  };
}

interface UseGitActionsResult {
  gitActions: GitActions;
  branchLabel: string;
  isGit: boolean;
}

export function useGitActions({ serverId, cwd, icons }: UseGitActionsInput): UseGitActionsResult {
  const toast = useToast();
  const [postShipArchiveSuggested, setPostShipArchiveSuggested] = useState(false);
  const [shipDefault, setShipDefault] = useState<"merge" | "pr">("merge");

  const { status, isLoading: isStatusLoading } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const baseRef = gitStatus?.baseRef ?? undefined;

  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);

  const { status: prStatus, githubFeaturesEnabled } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });

  // Ship default persistence
  const shipDefaultStorageKey = useMemo(() => {
    if (!gitStatus?.repoRoot) {
      return null;
    }
    return `@paseo:changes-ship-default:${gitStatus.repoRoot}`;
  }, [gitStatus?.repoRoot]);

  useEffect(() => {
    if (!shipDefaultStorageKey) {
      return;
    }
    let isActive = true;
    AsyncStorage.getItem(shipDefaultStorageKey)
      .then((value) => {
        if (!isActive) return;
        if (value === "pr" || value === "merge") {
          setShipDefault(value);
        }
        return;
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [shipDefaultStorageKey]);

  const persistShipDefault = useCallback(
    async (next: "merge" | "pr") => {
      setShipDefault(next);
      if (!shipDefaultStorageKey) return;
      try {
        await AsyncStorage.setItem(shipDefaultStorageKey, next);
      } catch {
        // Ignore persistence failures; default will reset to "merge".
      }
    },
    [shipDefaultStorageKey],
  );

  useEffect(() => {
    setPostShipArchiveSuggested(false);
  }, [cwd]);

  const commitStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "commit" }),
  );
  const pullStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "pull" }),
  );
  const pushStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "push" }),
  );
  const pullAndPushStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "pull-and-push" }),
  );
  const prCreateStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "create-pr" }),
  );
  const mergePrStatuses: Record<CheckoutPrMergeMethod, CheckoutGitActionStatus> = {
    squash: useCheckoutGitActionsStore((s) =>
      s.getStatus({ serverId, cwd, actionId: "merge-pr-squash" }),
    ),
    merge: useCheckoutGitActionsStore((s) =>
      s.getStatus({ serverId, cwd, actionId: "merge-pr-merge" }),
    ),
    rebase: useCheckoutGitActionsStore((s) =>
      s.getStatus({ serverId, cwd, actionId: "merge-pr-rebase" }),
    ),
  };
  const mergeStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "merge-branch" }),
  );
  const mergeFromBaseStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "merge-from-base" }),
  );
  const archiveStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "archive-worktree" }),
  );

  const runCommit = useCheckoutGitActionsStore((s) => s.commit);
  const runPull = useCheckoutGitActionsStore((s) => s.pull);
  const runPush = useCheckoutGitActionsStore((s) => s.push);
  const runPullAndPush = useCheckoutGitActionsStore((s) => s.pullAndPush);
  const runCreatePr = useCheckoutGitActionsStore((s) => s.createPr);
  const runMergePr = useCheckoutGitActionsStore((s) => s.mergePr);
  const runMergeBranch = useCheckoutGitActionsStore((s) => s.mergeBranch);
  const runMergeFromBase = useCheckoutGitActionsStore((s) => s.mergeFromBase);
  const runArchiveWorktree = useCheckoutGitActionsStore((s) => s.archiveWorktree);

  const toastActionError = useCallback(
    (error: unknown, fallback: string) => {
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message);
    },
    [toast],
  );

  const toastActionSuccess = useCallback(
    (message: string) => {
      toast.show(message, { variant: "success" });
    },
    [toast],
  );

  // Handlers
  const handleCommit = useCallback(() => {
    void runCommit({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Committed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to commit");
      });
  }, [cwd, runCommit, serverId, toastActionError, toastActionSuccess]);

  const handlePull = useCallback(() => {
    void runPull({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pulled");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to pull");
      });
  }, [cwd, runPull, serverId, toastActionError, toastActionSuccess]);

  const handlePush = useCallback(() => {
    void runPush({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pushed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to push");
      });
  }, [cwd, runPush, serverId, toastActionError, toastActionSuccess]);

  const handlePullAndPush = useCallback(() => {
    void runPullAndPush({ serverId, cwd })
      .then(() => {
        toastActionSuccess("Pulled and pushed");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to pull and push");
      });
  }, [cwd, runPullAndPush, serverId, toastActionError, toastActionSuccess]);

  const handleCreatePr = useCallback(() => {
    void persistShipDefault("pr");
    void runCreatePr({ serverId, cwd })
      .then(() => {
        toastActionSuccess("PR created");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to create PR");
      });
  }, [cwd, persistShipDefault, runCreatePr, serverId, toastActionError, toastActionSuccess]);

  const handleMergePr = useCallback(
    (method: CheckoutPrMergeMethod) => {
      void persistShipDefault("pr");
      void runMergePr({ serverId, cwd, method })
        .then(() => {
          setPostShipArchiveSuggested(true);
          toastActionSuccess("PR merged");
          return;
        })
        .catch((err) => {
          toastActionError(err, "Failed to merge PR");
        });
    },
    [cwd, persistShipDefault, runMergePr, serverId, toastActionError, toastActionSuccess],
  );

  const handleMergeBranch = useCallback(() => {
    if (!baseRef) {
      toast.error("Base ref unavailable");
      return;
    }
    void persistShipDefault("merge");
    void runMergeBranch({ serverId, cwd, baseRef })
      .then(() => {
        setPostShipArchiveSuggested(true);
        toastActionSuccess("Merged");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to merge");
      });
  }, [
    baseRef,
    cwd,
    persistShipDefault,
    runMergeBranch,
    serverId,
    toast,
    toastActionError,
    toastActionSuccess,
  ]);

  const handleMergeFromBase = useCallback(() => {
    if (!baseRef) {
      toast.error("Base ref unavailable");
      return;
    }
    void runMergeFromBase({ serverId, cwd, baseRef })
      .then(() => {
        toastActionSuccess("Updated");
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to merge from base");
      });
  }, [baseRef, cwd, runMergeFromBase, serverId, toast, toastActionError, toastActionSuccess]);

  const handleArchiveWorktree = useCallback(() => {
    const worktreePath = status?.cwd;
    if (!worktreePath) {
      toast.error("Worktree path unavailable");
      return;
    }
    const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
    const archivedWorkspaceId =
      resolveWorkspaceIdByExecutionDirectory({
        workspaces: workspaces?.values(),
        workspaceDirectory: worktreePath,
      }) ?? worktreePath;
    router.replace(
      buildWorkspaceArchiveRedirectRoute({
        serverId,
        archivedWorkspaceId,
        workspaces: workspaces?.values() ?? [],
      }) as Href,
    );
    void runArchiveWorktree({ serverId, cwd, worktreePath }).catch((err) => {
      toastActionError(err, "Failed to archive worktree");
    });
  }, [cwd, runArchiveWorktree, serverId, status, toast, toastActionError]);

  const baseRefLabel = useMemo(() => formatBaseRefLabel(baseRef), [baseRef]);
  const derived = deriveGitActionsState({
    isGit,
    status,
    gitStatus,
    prStatus,
    hasUncommittedChanges,
    postShipArchiveSuggested,
    isStatusLoading,
    baseRefLabel,
  });
  const {
    actionsDisabled,
    aheadCount,
    behindBaseCount,
    aheadOfOrigin,
    behindOfOrigin,
    hasPullRequest,
    hasRemote,
    isPaseoOwnedWorktree,
    isOnBaseBranch,
    shouldPromoteArchive,
  } = derived;

  const branchLabel = resolveBranchLabel({
    currentBranch: gitStatus?.currentBranch,
    notGit,
  });

  const handlePrAction = useCallback(() => {
    if (prStatus?.url) {
      openURLInNewTab(prStatus.url);
      return;
    }
    handleCreatePr();
  }, [prStatus?.url, handleCreatePr]);

  // Build actions
  const gitActions: GitActions = useMemo(() => {
    return buildGitActions({
      isGit,
      githubFeaturesEnabled,
      hasPullRequest,
      pullRequestUrl: prStatus?.url ?? null,
      pullRequestState: narrowPullRequestState(prStatus?.state),
      pullRequestIsDraft: prStatus?.isDraft ?? false,
      pullRequestIsMerged: prStatus?.isMerged ?? false,
      pullRequestMergeable: prStatus?.mergeable ?? "UNKNOWN",
      hasRemote,
      isPaseoOwnedWorktree,
      isOnBaseBranch,
      hasUncommittedChanges,
      baseRefAvailable: Boolean(baseRef),
      baseRefLabel,
      aheadCount,
      behindBaseCount,
      aheadOfOrigin,
      behindOfOrigin,
      shouldPromoteArchive,
      shipDefault,
      runtime: {
        commit: {
          disabled: isActionDisabled(actionsDisabled, commitStatus),
          status: commitStatus,
          icon: icons.commit,
          handler: handleCommit,
        },
        pull: {
          disabled: isActionDisabled(actionsDisabled, pullStatus),
          status: pullStatus,
          icon: icons.pull,
          handler: handlePull,
        },
        push: {
          disabled: isActionDisabled(actionsDisabled, pushStatus),
          status: pushStatus,
          icon: icons.push,
          handler: handlePush,
        },
        "pull-and-push": {
          disabled: isActionDisabled(actionsDisabled, pullAndPushStatus),
          status: pullAndPushStatus,
          icon: icons.pullAndPush,
          handler: handlePullAndPush,
        },
        pr: {
          disabled: isActionDisabled(actionsDisabled, prCreateStatus),
          status: hasPullRequest ? "idle" : prCreateStatus,
          icon: hasPullRequest ? icons.viewPr : icons.createPr,
          handler: handlePrAction,
        },
        "merge-pr-squash": {
          disabled: isActionDisabled(actionsDisabled, mergePrStatuses.squash),
          status: mergePrStatuses.squash,
          icon: icons.mergePrSquash,
          handler: () => handleMergePr("squash"),
        },
        "merge-pr-merge": {
          disabled: isActionDisabled(actionsDisabled, mergePrStatuses.merge),
          status: mergePrStatuses.merge,
          icon: icons.mergePrMerge,
          handler: () => handleMergePr("merge"),
        },
        "merge-pr-rebase": {
          disabled: isActionDisabled(actionsDisabled, mergePrStatuses.rebase),
          status: mergePrStatuses.rebase,
          icon: icons.mergePrRebase,
          handler: () => handleMergePr("rebase"),
        },
        "merge-branch": {
          disabled: isActionDisabled(actionsDisabled, mergeStatus),
          status: mergeStatus,
          icon: icons.merge,
          handler: handleMergeBranch,
        },
        "merge-from-base": {
          disabled: isActionDisabled(actionsDisabled, mergeFromBaseStatus),
          status: mergeFromBaseStatus,
          icon: icons.mergeFromBase,
          handler: handleMergeFromBase,
        },
        "archive-worktree": {
          disabled: isActionDisabled(actionsDisabled, archiveStatus),
          status: archiveStatus,
          icon: icons.archive,
          handler: handleArchiveWorktree,
        },
      },
    });
  }, [
    isGit,
    hasRemote,
    hasPullRequest,
    prStatus?.url,
    prStatus?.state,
    prStatus?.isDraft,
    prStatus?.isMerged,
    prStatus?.mergeable,
    aheadCount,
    behindBaseCount,
    isPaseoOwnedWorktree,
    isOnBaseBranch,
    githubFeaturesEnabled,
    hasUncommittedChanges,
    aheadOfOrigin,
    behindOfOrigin,
    shipDefault,
    baseRefLabel,
    shouldPromoteArchive,
    actionsDisabled,
    commitStatus,
    pullStatus,
    pushStatus,
    pullAndPushStatus,
    prCreateStatus,
    mergePrStatuses.squash,
    mergePrStatuses.merge,
    mergePrStatuses.rebase,
    mergeStatus,
    mergeFromBaseStatus,
    archiveStatus,
    handleCommit,
    handlePull,
    handlePush,
    handlePullAndPush,
    handlePrAction,
    handleMergePr,
    handleMergeBranch,
    handleMergeFromBase,
    handleArchiveWorktree,
    icons,
    baseRef,
  ]);

  return { gitActions, branchLabel, isGit };
}
