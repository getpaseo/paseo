import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  type CheckoutDiffSubscriber,
  CheckoutSession,
  type CheckoutSessionHost,
} from "./checkout-session.js";
import { createGitHubService } from "../../../services/github-service.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  CheckoutDiffCompareInput,
  CheckoutDiffSnapshotPayload,
} from "../../checkout-diff-manager.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import {
  createNoGitWorkspaceRuntimeSnapshot,
  createNoopWorkspaceGitService,
} from "../../test-utils/workspace-git-service-stub.js";
import { expandTilde } from "../../../utils/path.js";

interface FakeDiffSubscription {
  cwd: string;
  compare: CheckoutDiffCompareInput;
  listener: (snapshot: CheckoutDiffSnapshotPayload) => void;
  unsubscribeCalls: number;
}

function createFakeDiffSubscriber(initial: CheckoutDiffSnapshotPayload) {
  const subscriptions: FakeDiffSubscription[] = [];
  const refreshedCwds: string[] = [];
  const subscriber: CheckoutDiffSubscriber = {
    subscribe: async (params, listener) => {
      const subscription: FakeDiffSubscription = {
        cwd: params.cwd,
        compare: params.compare,
        listener,
        unsubscribeCalls: 0,
      };
      subscriptions.push(subscription);
      return {
        initial: { ...initial, cwd: params.cwd },
        unsubscribe: () => {
          subscription.unsubscribeCalls += 1;
        },
      };
    },
    scheduleRefreshForCwd: (cwd) => {
      refreshedCwds.push(cwd);
    },
  };
  return { subscriber, subscriptions, refreshedCwds };
}

function makeCheckoutSession(options?: {
  git?: Partial<WorkspaceGitService>;
  diff?: CheckoutDiffSubscriber;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const host: CheckoutSessionHost = { emit: (msg) => emitted.push(msg) };
  const checkout = new CheckoutSession({
    host,
    workspaceGitService: createNoopWorkspaceGitService(options?.git),
    github: createGitHubService(),
    checkoutDiffManager:
      options?.diff ?? createFakeDiffSubscriber({ cwd: "", files: [], error: null }).subscriber,
    logger: pino({ level: "silent" }),
  });
  return { checkout, emitted };
}

function createGitSnapshot(cwd: string, currentBranch: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: cwd,
      currentBranch,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    github: { featuresEnabled: false, pullRequest: null, error: null },
  };
}

describe("CheckoutSession", () => {
  describe("status", () => {
    it("emits a checkout status response built from the git snapshot", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { getSnapshot: async () => createGitSnapshot("/repo", "main") },
      });

      await checkout.handleStatusRequest({
        type: "checkout_status_request",
        cwd: "/repo",
        requestId: "r1",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_status_response",
          payload: expect.objectContaining({
            cwd: "/repo",
            requestId: "r1",
            isGit: true,
            currentBranch: "main",
          }),
        },
      ]);
    });

    it("emits an error status response when the git snapshot read fails", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          getSnapshot: async () => {
            throw new Error("boom");
          },
        },
      });

      await checkout.handleStatusRequest({
        type: "checkout_status_request",
        cwd: "/repo",
        requestId: "r2",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_status_response",
          payload: expect.objectContaining({
            cwd: "/repo",
            requestId: "r2",
            isGit: false,
            error: { code: "UNKNOWN", message: "boom" },
          }),
        },
      ]);
    });
  });

  describe("validate branch", () => {
    it("validates an existing local branch", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { validateBranchRef: async () => ({ kind: "local", name: "feature" }) },
      });

      await checkout.handleValidateBranchRequest({
        type: "validate_branch_request",
        cwd: "/repo",
        branchName: "feature",
        requestId: "r3",
      });

      expect(emitted).toEqual([
        {
          type: "validate_branch_response",
          payload: {
            exists: true,
            resolvedRef: "feature",
            isRemote: false,
            error: null,
            requestId: "r3",
          },
        },
      ]);
    });

    it("reports a missing branch as not found", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { validateBranchRef: async () => ({ kind: "not-found" }) },
      });

      await checkout.handleValidateBranchRequest({
        type: "validate_branch_request",
        cwd: "/repo",
        branchName: "ghost",
        requestId: "r4",
      });

      expect(emitted).toEqual([
        {
          type: "validate_branch_response",
          payload: {
            exists: false,
            resolvedRef: null,
            isRemote: false,
            error: null,
            requestId: "r4",
          },
        },
      ]);
    });

    it("rejects an unsafe branch ref before touching git", async () => {
      let validateCalls = 0;
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          validateBranchRef: async () => {
            validateCalls += 1;
            return { kind: "not-found" };
          },
        },
      });

      await checkout.handleValidateBranchRequest({
        type: "validate_branch_request",
        cwd: "/repo",
        branchName: "bad ref!",
        requestId: "r5",
      });

      expect(validateCalls).toBe(0);
      expect(emitted).toEqual([
        {
          type: "validate_branch_response",
          payload: {
            exists: false,
            resolvedRef: null,
            isRemote: false,
            error: "Invalid branch: bad ref!",
            requestId: "r5",
          },
        },
      ]);
    });
  });

  describe("branch suggestions", () => {
    it("emits branch names and details", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          suggestBranchesForCwd: async () => [
            { name: "main", committerDate: 1, hasLocal: true, hasRemote: true },
            { name: "dev", committerDate: 2, hasLocal: true, hasRemote: false },
          ],
        },
      });

      await checkout.handleBranchSuggestionsRequest({
        type: "branch_suggestions_request",
        cwd: "/repo",
        requestId: "r6",
      });

      expect(emitted).toEqual([
        {
          type: "branch_suggestions_response",
          payload: {
            branches: ["main", "dev"],
            branchDetails: [
              { name: "main", committerDate: 1, hasLocal: true, hasRemote: true },
              { name: "dev", committerDate: 2, hasLocal: true, hasRemote: false },
            ],
            error: null,
            requestId: "r6",
          },
        },
      ]);
    });
  });

  describe("refresh", () => {
    it("forces a github-inclusive snapshot, nudges diffs, and confirms success", async () => {
      const snapshotCalls: Array<{ cwd: string; options: unknown }> = [];
      const { subscriber, refreshedCwds } = createFakeDiffSubscriber({
        cwd: "",
        files: [],
        error: null,
      });
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          getSnapshot: async (cwd, snapshotOptions) => {
            snapshotCalls.push({ cwd, options: snapshotOptions });
            return createNoGitWorkspaceRuntimeSnapshot(cwd);
          },
        },
        diff: subscriber,
      });

      await checkout.handleRefreshRequest({
        type: "checkout.refresh.request",
        cwd: "/repo",
        requestId: "r7",
      });

      expect(snapshotCalls).toEqual([
        { cwd: "/repo", options: { force: true, includeGitHub: true, reason: "manual-refresh" } },
      ]);
      expect(refreshedCwds).toEqual(["/repo"]);
      expect(emitted).toEqual([
        {
          type: "checkout.refresh.response",
          payload: { cwd: "/repo", success: true, error: null, requestId: "r7" },
        },
      ]);
    });

    it("expands a tilde cwd before refreshing git and diffs", async () => {
      const snapshotCalls: string[] = [];
      const { subscriber, refreshedCwds } = createFakeDiffSubscriber({
        cwd: "",
        files: [],
        error: null,
      });
      const { checkout } = makeCheckoutSession({
        git: {
          getSnapshot: async (cwd) => {
            snapshotCalls.push(cwd);
            return createNoGitWorkspaceRuntimeSnapshot(cwd);
          },
        },
        diff: subscriber,
      });

      await checkout.handleRefreshRequest({
        type: "checkout.refresh.request",
        cwd: "~/repo",
        requestId: "r-tilde",
      });

      const resolvedCwd = expandTilde("~/repo");
      expect(snapshotCalls).toEqual([resolvedCwd]);
      expect(refreshedCwds).toEqual([resolvedCwd]);
    });
  });

  describe("diff subscriptions", () => {
    it("opens a subscription, streams updates tagged with the id, and tears down on unsubscribe", async () => {
      const { subscriber, subscriptions } = createFakeDiffSubscriber({
        cwd: "/repo",
        files: [],
        error: null,
      });
      const { checkout, emitted } = makeCheckoutSession({ diff: subscriber });

      await checkout.handleSubscribeDiffRequest({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "s1",
        cwd: "/repo",
        compare: { mode: "uncommitted" },
        requestId: "r8",
      });

      expect(emitted).toEqual([
        {
          type: "subscribe_checkout_diff_response",
          payload: { subscriptionId: "s1", cwd: "/repo", files: [], error: null, requestId: "r8" },
        },
      ]);
      expect(subscriptions).toHaveLength(1);

      subscriptions[0].listener({
        cwd: "/repo",
        files: [],
        error: { code: "UNKNOWN", message: "transient" },
      });

      expect(emitted[1]).toEqual({
        type: "checkout_diff_update",
        payload: {
          subscriptionId: "s1",
          cwd: "/repo",
          files: [],
          error: { code: "UNKNOWN", message: "transient" },
        },
      });

      checkout.handleUnsubscribeDiffRequest({
        type: "unsubscribe_checkout_diff_request",
        subscriptionId: "s1",
      });

      expect(subscriptions[0].unsubscribeCalls).toBe(1);
    });

    it("replaces an existing subscription when the same id subscribes again", async () => {
      const { subscriber, subscriptions } = createFakeDiffSubscriber({
        cwd: "/repo",
        files: [],
        error: null,
      });
      const { checkout } = makeCheckoutSession({ diff: subscriber });

      await checkout.handleSubscribeDiffRequest({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "s1",
        cwd: "/repo",
        compare: { mode: "uncommitted" },
        requestId: "first",
      });
      await checkout.handleSubscribeDiffRequest({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "s1",
        cwd: "/repo",
        compare: { mode: "uncommitted" },
        requestId: "second",
      });

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0].unsubscribeCalls).toBe(1);
      expect(subscriptions[1].unsubscribeCalls).toBe(0);
    });

    it("unsubscribes every live subscription on cleanup", async () => {
      const { subscriber, subscriptions } = createFakeDiffSubscriber({
        cwd: "/repo",
        files: [],
        error: null,
      });
      const { checkout } = makeCheckoutSession({ diff: subscriber });

      await checkout.handleSubscribeDiffRequest({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "s1",
        cwd: "/repo",
        compare: { mode: "uncommitted" },
        requestId: "r",
      });
      await checkout.handleSubscribeDiffRequest({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "s2",
        cwd: "/repo",
        compare: { mode: "uncommitted" },
        requestId: "r",
      });

      checkout.cleanup();

      expect(subscriptions[0].unsubscribeCalls).toBe(1);
      expect(subscriptions[1].unsubscribeCalls).toBe(1);
    });
  });

  describe("status updates", () => {
    it("emits a checkout status update for a workspace git snapshot", () => {
      const { checkout, emitted } = makeCheckoutSession();

      checkout.emitStatusUpdate("/repo", createGitSnapshot("/repo", "main"));

      expect(emitted).toEqual([
        {
          type: "checkout_status_update",
          payload: expect.objectContaining({ cwd: "/repo", currentBranch: "main" }),
        },
      ]);
    });
  });
});
