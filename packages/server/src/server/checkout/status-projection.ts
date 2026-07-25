import type {
  CheckoutPrStatusResponse,
  CheckoutStatusResponse,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { isGitHubPullRequestStatusFacts } from "../../services/github-facts.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

type CheckoutPrStatusPayload = Extract<
  SessionOutboundMessage,
  { type: "checkout_pr_status_response" }
>["payload"];
type CheckoutPrStatusPayloadStatus = NonNullable<CheckoutPrStatusPayload["status"]>;
type CheckoutPrStatusWireStatus = Omit<CheckoutPrStatusPayloadStatus, "forge"> & {
  forge?: string;
};

export function buildCheckoutStatusPayloadFromSnapshot({
  cwd,
  requestId,
  snapshot,
}: {
  cwd: string;
  requestId: string;
  snapshot: WorkspaceGitRuntimeSnapshot;
}): CheckoutStatusResponse["payload"] {
  if (!snapshot.git.isGit) {
    return {
      cwd,
      isGit: false,
      repoRoot: null,
      currentBranch: null,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      error: null,
      requestId,
    };
  }

  if (snapshot.git.repoRoot === null || snapshot.git.isDirty === null) {
    throw new Error("Workspace git snapshot is missing required checkout status fields");
  }

  if (snapshot.git.isPaseoOwnedWorktree) {
    if (snapshot.git.mainRepoRoot === null || snapshot.git.baseRef === null) {
      throw new Error("Workspace git snapshot is missing required worktree status fields");
    }

    return {
      cwd,
      isGit: true,
      repoRoot: snapshot.git.repoRoot,
      mainRepoRoot: snapshot.git.mainRepoRoot,
      currentBranch: snapshot.git.currentBranch ?? null,
      isDirty: snapshot.git.isDirty,
      baseRef: snapshot.git.baseRef,
      aheadBehind: snapshot.git.aheadBehind ?? null,
      aheadOfOrigin: snapshot.git.aheadOfOrigin ?? null,
      behindOfOrigin: snapshot.git.behindOfOrigin ?? null,
      hasRemote: snapshot.git.hasRemote,
      remoteUrl: snapshot.git.remoteUrl,
      isPaseoOwnedWorktree: true,
      error: null,
      requestId,
    };
  }

  return {
    cwd,
    isGit: true,
    repoRoot: snapshot.git.repoRoot,
    mainRepoRoot: snapshot.git.mainRepoRoot,
    currentBranch: snapshot.git.currentBranch ?? null,
    isDirty: snapshot.git.isDirty,
    baseRef: snapshot.git.baseRef ?? null,
    aheadBehind: snapshot.git.aheadBehind ?? null,
    aheadOfOrigin: snapshot.git.aheadOfOrigin ?? null,
    behindOfOrigin: snapshot.git.behindOfOrigin ?? null,
    hasRemote: snapshot.git.hasRemote,
    remoteUrl: snapshot.git.remoteUrl,
    isPaseoOwnedWorktree: false,
    error: null,
    requestId,
  };
}

export function buildCheckoutPrStatusPayloadFromSnapshot({
  cwd,
  requestId,
  snapshot,
}: {
  cwd: string;
  requestId: string;
  snapshot: WorkspaceGitRuntimeSnapshot;
}): CheckoutPrStatusResponse["payload"] {
  // Prefer the forge resolved during snapshot refresh (probe-aware, so
  // self-managed GitLab hosts are correct). forgeSpecific.forge is only a facts
  // family tag, not a brand id, so unresolved snapshots stay unlabeled.
  const forge = snapshot.forge.forge;
  return {
    cwd,
    status: normalizeCheckoutPrStatusPayload(snapshot.forge.pullRequest, forge),
    githubFeaturesEnabled: snapshot.forge.featuresEnabled,
    authState: snapshot.forge.authState,
    ...(forge ? { forge } : {}),
    error: snapshot.forge.error
      ? {
          code: "UNKNOWN",
          message: snapshot.forge.error.message,
        }
      : null,
    requestId,
  } as CheckoutPrStatusResponse["payload"];
}

export function normalizeCheckoutPrStatusPayload(
  status: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
  forge?: string,
): CheckoutPrStatusPayloadStatus | null {
  if (!status) {
    return null;
  }
  const payload: CheckoutPrStatusWireStatus = {
    ...(forge ? { forge } : {}),
    number: status.number,
    url: status.url,
    title: status.title,
    state: status.state,
    repoOwner: status.repoOwner,
    repoName: status.repoName,
    baseRefName: status.baseRefName,
    headRefName: status.headRefName,
    isMerged: status.isMerged,
    isDraft: status.isDraft ?? false,
    mergeable: status.mergeable ?? "UNKNOWN",
    checks: status.checks ?? [],
    checksStatus: status.checksStatus,
    reviewDecision: status.reviewDecision,
  };
  if (status.projectPath) {
    payload.projectPath = status.projectPath;
  } else if (status.repoOwner && status.repoName) {
    payload.projectPath = `${status.repoOwner}/${status.repoName}`;
  }
  if (status.forgeSpecific) {
    payload.forgeSpecific = status.forgeSpecific;
    // COMPAT(forgeSpecific): added in v0.1.106, remove after 2026-12-27. Keep
    // mirroring GitHub facts onto `github` for clients that predate forgeSpecific;
    // drop once the daemon floor >= v0.1.106.
    if (isGitHubPullRequestStatusFacts(status.forgeSpecific)) {
      const { forge: _forge, ...githubFacts } = status.forgeSpecific;
      payload.github = githubFacts;
    }
  }
  return payload as CheckoutPrStatusPayloadStatus;
}
