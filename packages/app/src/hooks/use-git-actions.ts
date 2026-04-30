import { useState, useCallback, useEffect, useMemo, type ReactElement } from "react";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type CheckoutGitActionStatus,
  useCheckoutGitActionsStore,
} from "@/stores/checkout-git-actions-store";
import {
  type CheckoutStatusPayload,
  useCheckoutStatusQuery,
} from "@/hooks/use-checkout-status-query";
import {
  type CheckoutPrStatusPayload,
  useCheckoutPrStatusQuery,
} from "@/hooks/use-checkout-pr-status-query";
import { buildGitActions, type GitActions } from "@/components/git-actions-policy";
import { buildNewAgentRoute, resolveNewAgentWorkingDir } from "@/utils/new-agent-routing";
import { openExternalUrl } from "@/utils/open-external-url";
import { useToast } from "@/contexts/toast-context";

export type { GitActionId, GitAction, GitActions } from "@/components/git-actions-policy";

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

function useGitActionStatuses(
  serverId: string,
  cwd: string,
): {
  commitStatus: CheckoutGitActionStatus;
  pullStatus: CheckoutGitActionStatus;
  pushStatus: CheckoutGitActionStatus;
  pullAndPushStatus: CheckoutGitActionStatus;
  prCreateStatus: CheckoutGitActionStatus;
  mergeStatus: CheckoutGitActionStatus;
  mergeFromBaseStatus: CheckoutGitActionStatus;
  archiveStatus: CheckoutGitActionStatus;
} {
  const commitStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "commit" }),
  );
  const pullStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "pull" }),
  );
  const pushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "push" }),
  );
  const pullAndPushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "pull-and-push" }),
  );
  const prCreateStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "create-pr" }),
  );
  const mergeStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-branch" }),
  );
  const mergeFromBaseStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-from-base" }),
  );
  const archiveStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "archive-worktree" }),
  );
  return {
    commitStatus,
    pullStatus,
    pushStatus,
    pullAndPushStatus,
    prCreateStatus,
    mergeStatus,
    mergeFromBaseStatus,
    archiveStatus,
  };
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

function useGitActionRunners() {
  const runCommit = useCheckoutGitActionsStore((state) => state.commit);
  const runPull = useCheckoutGitActionsStore((state) => state.pull);
  const runPush = useCheckoutGitActionsStore((state) => state.push);
  const runPullAndPush = useCheckoutGitActionsStore((state) => state.pullAndPush);
  const runCreatePr = useCheckoutGitActionsStore((state) => state.createPr);
  const runMergeBranch = useCheckoutGitActionsStore((state) => state.mergeBranch);
  const runMergeFromBase = useCheckoutGitActionsStore((state) => state.mergeFromBase);
  const runArchiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);
  return {
    runCommit,
    runPull,
    runPush,
    runPullAndPush,
    runCreatePr,
    runMergeBranch,
    runMergeFromBase,
    runArchiveWorktree,
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
  const router = useRouter();
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

  const {
    commitStatus,
    pullStatus,
    pushStatus,
    pullAndPushStatus,
    prCreateStatus,
    mergeStatus,
    mergeFromBaseStatus,
    archiveStatus,
  } = useGitActionStatuses(serverId, cwd);

  const {
    runCommit,
    runPull,
    runPush,
    runPullAndPush,
    runCreatePr,
    runMergeBranch,
    runMergeFromBase,
    runArchiveWorktree,
  } = useGitActionRunners();

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
    const targetWorkingDir = resolveNewAgentWorkingDir(cwd, status ?? null);
    void runArchiveWorktree({ serverId, cwd, worktreePath })
      .then(() => {
        router.replace(buildNewAgentRoute(serverId, targetWorkingDir));
        return;
      })
      .catch((err) => {
        toastActionError(err, "Failed to archive worktree");
      });
  }, [cwd, router, runArchiveWorktree, serverId, status, toast, toastActionError]);

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

  const commitDisabled = isActionDisabled(actionsDisabled, commitStatus);
  const pullDisabled = isActionDisabled(actionsDisabled, pullStatus);
  const prDisabled = isActionDisabled(actionsDisabled, prCreateStatus);
  const mergeDisabled = isActionDisabled(actionsDisabled, mergeStatus);
  const mergeFromBaseDisabled = isActionDisabled(actionsDisabled, mergeFromBaseStatus);
  const pushDisabled = isActionDisabled(actionsDisabled, pushStatus);
  const pullAndPushDisabled = isActionDisabled(actionsDisabled, pullAndPushStatus);
  const archiveDisabled = isActionDisabled(actionsDisabled, archiveStatus);

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
          disabled: commitDisabled,
          status: commitStatus,
          icon: icons.commit,
          handler: handleCommit,
        },
        pull: {
          disabled: pullDisabled,
          status: pullStatus,
          icon: icons.pull,
          handler: handlePull,
        },
        push: {
          disabled: pushDisabled,
          status: pushStatus,
          icon: icons.push,
          handler: handlePush,
        },
        "pull-and-push": {
          disabled: pullAndPushDisabled,
          status: pullAndPushStatus,
          icon: icons.pullAndPush,
          handler: handlePullAndPush,
        },
        pr: {
          disabled: prDisabled,
          status: hasPullRequest ? "idle" : prCreateStatus,
          icon: hasPullRequest ? icons.viewPr : icons.createPr,
          handler: handlePrAction,
        },
        "merge-branch": {
          disabled: mergeDisabled,
          status: mergeStatus,
          icon: icons.merge,
          handler: handleMergeBranch,
        },
        "merge-from-base": {
          disabled: mergeFromBaseDisabled,
          status: mergeFromBaseStatus,
          icon: icons.mergeFromBase,
          handler: handleMergeFromBase,
        },
        "archive-worktree": {
          disabled: archiveDisabled,
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
    commitDisabled,
    pullDisabled,
    pushDisabled,
    pullAndPushDisabled,
    prDisabled,
    mergeDisabled,
    mergeFromBaseDisabled,
    archiveDisabled,
    commitStatus,
    pullStatus,
    pushStatus,
    pullAndPushStatus,
    prCreateStatus,
    mergeStatus,
    mergeFromBaseStatus,
    archiveStatus,
    handleCommit,
    handlePull,
    handlePush,
    handlePullAndPush,
    handlePrAction,
    handleMergeBranch,
    handleMergeFromBase,
    handleArchiveWorktree,
    icons,
    baseRef,
  ]);

  return { gitActions, branchLabel, isGit };
}
