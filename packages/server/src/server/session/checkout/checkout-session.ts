import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  BranchSuggestionsRequest,
  CheckoutRefreshRequest,
  CheckoutStatusRequest,
  SessionOutboundMessage,
  SubscribeCheckoutDiffRequest,
  UnsubscribeCheckoutDiffRequest,
  ValidateBranchRequest,
} from "../../messages.js";
import type {
  CheckoutDiffCompareInput,
  CheckoutDiffSnapshotPayload,
} from "../../checkout-diff-manager.js";
import { toCheckoutError } from "../../checkout-git-utils.js";
import {
  buildCheckoutPrStatusPayloadFromSnapshot,
  buildCheckoutStatusPayloadFromSnapshot,
} from "../../checkout/status-projection.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import { assertSafeGitRef } from "../../worktree-session.js";
import type { GitHubService } from "../../../services/github-service.js";
import { expandTilde } from "../../../utils/path.js";

export interface CheckoutSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/**
 * The slice of CheckoutDiffManager that CheckoutSession needs: open a live diff
 * subscription, and nudge open subscriptions to recompute after a mutation. The
 * real CheckoutDiffManager satisfies this structurally; tests supply a fake.
 */
export interface CheckoutDiffSubscriber {
  subscribe(
    params: { cwd: string; compare: CheckoutDiffCompareInput },
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): Promise<{ initial: CheckoutDiffSnapshotPayload; unsubscribe: () => void }>;
  scheduleRefreshForCwd(cwd: string): void;
}

export interface CheckoutSessionOptions {
  host: CheckoutSessionHost;
  workspaceGitService: WorkspaceGitService;
  github: GitHubService;
  checkoutDiffManager: CheckoutDiffSubscriber;
  logger: pino.Logger;
}

/**
 * The read & live-stream side of a client's checkout view: status queries,
 * branch validation/suggestions, manual refresh, and the live git-diff and
 * checkout-status subscriptions.
 *
 * The command operations (switch/rename/commit/merge/pull/push/stash) and the
 * GitHub-PR operations still live on Session; they keep the diff in sync by
 * calling scheduleDiffRefresh(), and the workspace git observer streams branch
 * changes through emitStatusUpdate().
 */
export class CheckoutSession {
  private readonly host: CheckoutSessionHost;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly github: GitHubService;
  private readonly checkoutDiffManager: CheckoutDiffSubscriber;
  private readonly logger: pino.Logger;
  private readonly diffSubscriptions = new Map<string, () => void>();

  constructor(options: CheckoutSessionOptions) {
    this.host = options.host;
    this.workspaceGitService = options.workspaceGitService;
    this.github = options.github;
    this.checkoutDiffManager = options.checkoutDiffManager;
    this.logger = options.logger;
  }

  async handleStatusRequest(msg: CheckoutStatusRequest): Promise<void> {
    const { cwd, requestId } = msg;
    const resolvedCwd = expandTilde(cwd);

    try {
      const snapshot = await this.workspaceGitService.getSnapshot(resolvedCwd);
      this.host.emit({
        type: "checkout_status_response",
        payload: buildCheckoutStatusPayloadFromSnapshot({
          cwd,
          requestId,
          snapshot,
        }),
      });
    } catch (error) {
      this.host.emit({
        type: "checkout_status_response",
        payload: {
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
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  async handleValidateBranchRequest(msg: ValidateBranchRequest): Promise<void> {
    const { cwd, branchName, requestId } = msg;

    try {
      const resolvedCwd = expandTilde(cwd);
      assertSafeGitRef(branchName, "branch");

      const resolution = await this.workspaceGitService.validateBranchRef(resolvedCwd, branchName);
      switch (resolution.kind) {
        case "local":
          this.host.emit({
            type: "validate_branch_response",
            payload: {
              exists: true,
              resolvedRef: resolution.name,
              isRemote: false,
              error: null,
              requestId,
            },
          });
          return;
        case "remote-only":
          this.host.emit({
            type: "validate_branch_response",
            payload: {
              exists: true,
              resolvedRef: resolution.remoteRef,
              isRemote: true,
              error: null,
              requestId,
            },
          });
          return;
        case "not-found":
          this.host.emit({
            type: "validate_branch_response",
            payload: {
              exists: false,
              resolvedRef: null,
              isRemote: false,
              error: null,
              requestId,
            },
          });
          return;
        default: {
          const exhaustiveCheck: never = resolution;
          throw new Error(`Unhandled branch resolution: ${getErrorMessage(exhaustiveCheck)}`);
        }
      }
    } catch (error) {
      this.host.emit({
        type: "validate_branch_response",
        payload: {
          exists: false,
          resolvedRef: null,
          isRemote: false,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  async handleBranchSuggestionsRequest(msg: BranchSuggestionsRequest): Promise<void> {
    const { cwd, query, limit, requestId } = msg;

    try {
      const resolvedCwd = expandTilde(cwd);
      const branchDetails = await this.workspaceGitService.suggestBranchesForCwd(resolvedCwd, {
        query,
        limit,
      });
      this.host.emit({
        type: "branch_suggestions_response",
        payload: {
          branches: branchDetails.map((branch) => branch.name),
          branchDetails,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "branch_suggestions_response",
        payload: {
          branches: [],
          branchDetails: [],
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  async handleSubscribeDiffRequest(msg: SubscribeCheckoutDiffRequest): Promise<void> {
    const cwd = expandTilde(msg.cwd);
    this.diffSubscriptions.get(msg.subscriptionId)?.();
    this.diffSubscriptions.delete(msg.subscriptionId);
    const subscription = await this.checkoutDiffManager.subscribe(
      { cwd, compare: msg.compare },
      (snapshot) => {
        this.host.emit({
          type: "checkout_diff_update",
          payload: {
            subscriptionId: msg.subscriptionId,
            ...snapshot,
          },
        });
      },
    );
    this.diffSubscriptions.set(msg.subscriptionId, subscription.unsubscribe);

    this.host.emit({
      type: "subscribe_checkout_diff_response",
      payload: {
        subscriptionId: msg.subscriptionId,
        ...subscription.initial,
        requestId: msg.requestId,
      },
    });
  }

  handleUnsubscribeDiffRequest(msg: UnsubscribeCheckoutDiffRequest): void {
    this.diffSubscriptions.get(msg.subscriptionId)?.();
    this.diffSubscriptions.delete(msg.subscriptionId);
  }

  async handleRefreshRequest(msg: CheckoutRefreshRequest): Promise<void> {
    const { cwd, requestId } = msg;
    const resolvedCwd = expandTilde(cwd);

    try {
      this.github.invalidate({ cwd: resolvedCwd });
      await this.workspaceGitService.getSnapshot(resolvedCwd, {
        force: true,
        includeGitHub: true,
        reason: "manual-refresh",
      });
      this.checkoutDiffManager.scheduleRefreshForCwd(resolvedCwd);
      this.host.emit({
        type: "checkout.refresh.response",
        payload: {
          cwd,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "checkout.refresh.response",
        payload: {
          cwd,
          success: false,
          error: toCheckoutError(error),
          requestId,
        },
      });
    }
  }

  emitStatusUpdate(cwd: string, snapshot: WorkspaceGitRuntimeSnapshot): void {
    try {
      const requestId = `subscription:${cwd}`;
      this.host.emit({
        type: "checkout_status_update",
        payload: {
          ...buildCheckoutStatusPayloadFromSnapshot({
            cwd,
            requestId,
            snapshot,
          }),
          prStatus: buildCheckoutPrStatusPayloadFromSnapshot({
            cwd,
            requestId,
            snapshot,
          }),
        },
      });
    } catch (error) {
      this.logger.warn({ err: error, cwd }, "Failed to emit workspace checkout status update");
    }
  }

  /**
   * Notify the live diff subscriptions that the working tree at `cwd` changed.
   * Called by the command handlers that still live on Session after they mutate
   * the repository.
   */
  scheduleDiffRefresh(cwd: string): void {
    this.checkoutDiffManager.scheduleRefreshForCwd(cwd);
  }

  cleanup(): void {
    for (const unsubscribe of this.diffSubscriptions.values()) {
      unsubscribe();
    }
    this.diffSubscriptions.clear();
  }
}
