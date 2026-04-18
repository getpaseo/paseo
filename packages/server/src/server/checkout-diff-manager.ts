import type pino from "pino";
import type { SubscribeCheckoutDiffRequest, SessionOutboundMessage } from "./messages.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { getCheckoutDiff } from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import { toCheckoutError } from "./checkout-git-utils.js";

const CHECKOUT_DIFF_WATCH_DEBOUNCE_MS = 150;

export type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];

export type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;

export type CheckoutDiffMetrics = {
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
};

type CheckoutDiffWatchTarget = {
  key: string;
  cwd: string;
  diffCwd: string;
  compare: CheckoutDiffCompareInput;
  listeners: Set<(snapshot: CheckoutDiffSnapshotPayload) => void>;
  workingTreeWatchUnsubscribe: (() => void) | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  latestPayload: CheckoutDiffSnapshotPayload | null;
  latestFingerprint: string | null;
};

export class CheckoutDiffManager {
  private readonly paseoHome: string;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly targets = new Map<string, CheckoutDiffWatchTarget>();

  constructor(options: {
    logger: pino.Logger;
    paseoHome: string;
    workspaceGitService: WorkspaceGitService;
  }) {
    this.paseoHome = options.paseoHome;
    this.workspaceGitService = options.workspaceGitService;
  }

  async subscribe(
    params: {
      cwd: string;
      compare: CheckoutDiffCompareInput;
    },
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): Promise<{ initial: CheckoutDiffSnapshotPayload; unsubscribe: () => void }> {
    const cwd = params.cwd;
    const compare = this.normalizeCompare(params.compare);
    const target = await this.ensureTarget(cwd, compare);
    target.listeners.add(listener);

    const initial =
      target.latestPayload ??
      (await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
        diffCwd: target.diffCwd,
      }));
    target.latestPayload = initial;
    target.latestFingerprint = JSON.stringify(initial);
    return {
      initial,
      unsubscribe: () => {
        this.removeListener(target.key, listener);
      },
    };
  }

  scheduleRefreshForCwd(cwd: string): void {
    const resolvedCwd = expandTilde(cwd);
    for (const target of this.targets.values()) {
      if (target.cwd !== resolvedCwd && target.diffCwd !== resolvedCwd) {
        continue;
      }
      this.scheduleTargetRefresh(target);
    }
  }

  getMetrics(): CheckoutDiffMetrics {
    let checkoutDiffSubscriptionCount = 0;

    for (const target of this.targets.values()) {
      checkoutDiffSubscriptionCount += target.listeners.size;
    }

    return {
      checkoutDiffTargetCount: this.targets.size,
      checkoutDiffSubscriptionCount,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.closeTarget(target);
    }
    this.targets.clear();
  }

  private normalizeCompare(compare: CheckoutDiffCompareInput): CheckoutDiffCompareInput {
    const ignoreWhitespace = compare.ignoreWhitespace === true;
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted", ignoreWhitespace };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    return trimmedBaseRef
      ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace }
      : { mode: "base", ignoreWhitespace };
  }

  private buildTargetKey(cwd: string, compare: CheckoutDiffCompareInput): string {
    return JSON.stringify([
      cwd,
      compare.mode,
      compare.mode === "base" ? (compare.baseRef ?? "") : "",
      compare.ignoreWhitespace === true,
    ]);
  }

  private closeTarget(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    target.workingTreeWatchUnsubscribe?.();
    target.workingTreeWatchUnsubscribe = null;
    target.listeners.clear();
  }

  private removeListener(
    targetKey: string,
    listener: (snapshot: CheckoutDiffSnapshotPayload) => void,
  ): void {
    const target = this.targets.get(targetKey);
    if (!target) {
      return;
    }
    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }
    this.closeTarget(target);
    this.targets.delete(targetKey);
  }

  private scheduleTargetRefresh(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      void this.refreshTarget(target);
    }, CHECKOUT_DIFF_WATCH_DEBOUNCE_MS);
  }

  private async computeCheckoutDiffSnapshot(
    cwd: string,
    compare: CheckoutDiffCompareInput,
    options?: { diffCwd?: string },
  ): Promise<CheckoutDiffSnapshotPayload> {
    const diffCwd = options?.diffCwd ?? cwd;
    try {
      const diffResult = await getCheckoutDiff(
        diffCwd,
        {
          mode: compare.mode,
          baseRef: compare.baseRef,
          ignoreWhitespace: compare.ignoreWhitespace,
          includeStructured: true,
        },
        { paseoHome: this.paseoHome },
      );
      const files = [...(diffResult.structured ?? [])];
      files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
      });
      return {
        cwd,
        files,
        error: null,
      };
    } catch (error) {
      return {
        cwd,
        files: [],
        error: toCheckoutError(error),
      };
    }
  }

  private async refreshTarget(target: CheckoutDiffWatchTarget): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      return;
    }

    target.refreshPromise = (async () => {
      do {
        target.refreshQueued = false;
        const snapshot = await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
          diffCwd: target.diffCwd,
        });
        target.latestPayload = snapshot;
        const fingerprint = JSON.stringify(snapshot);
        if (fingerprint !== target.latestFingerprint) {
          target.latestFingerprint = fingerprint;
          for (const listener of target.listeners) {
            listener(snapshot);
          }
        }
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  private async ensureTarget(
    cwd: string,
    compare: CheckoutDiffCompareInput,
  ): Promise<CheckoutDiffWatchTarget> {
    const targetKey = this.buildTargetKey(cwd, compare);
    const existing = this.targets.get(targetKey);
    if (existing) {
      return existing;
    }

    const target: CheckoutDiffWatchTarget = {
      key: targetKey,
      cwd,
      diffCwd: cwd,
      compare,
      listeners: new Set(),
      workingTreeWatchUnsubscribe: null,
      debounceTimer: null,
      refreshPromise: null,
      refreshQueued: false,
      latestPayload: null,
      latestFingerprint: null,
    };
    const { repoRoot, unsubscribe } = await this.workspaceGitService.requestWorkingTreeWatch(
      cwd,
      () => this.scheduleTargetRefresh(target),
    );
    target.diffCwd = repoRoot ?? cwd;
    target.workingTreeWatchUnsubscribe = unsubscribe;

    this.targets.set(targetKey, target);
    return target;
  }
}
