import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  type CheckoutDiffSubscriber,
  CheckoutSession,
  type CheckoutSessionHost,
} from "./checkout-session.js";
import { createGitHubService, type GitHubService } from "../../../services/github-service.js";
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
import type { GitMetadataGenerator } from "./git-metadata-generator.js";

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

interface RecordedHostCalls {
  notifyGitMutation: Array<{
    cwd: string;
    reason: string;
    options?: { invalidateGithub?: boolean };
  }>;
  emitWorkspaceUpdateForCwd: string[];
  handleWorkspaceGitBranchSnapshot: Array<{ cwd: string; branchName: string | null }>;
  renameCurrentBranch: Array<{ cwd: string; branch: string }>;
  checkoutExistingBranch: Array<{ cwd: string; branch: string }>;
}

interface RecordedGeneratorCalls {
  generateCommitMessage: string[];
  generatePullRequestText: Array<{ cwd: string; baseRef?: string }>;
}

function makeCheckoutSession(options?: {
  git?: Partial<WorkspaceGitService>;
  diff?: CheckoutDiffSubscriber;
  github?: Partial<GitHubService>;
  host?: Partial<CheckoutSessionHost>;
  gitMetadataGenerator?: Partial<GitMetadataGenerator>;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const hostCalls: RecordedHostCalls = {
    notifyGitMutation: [],
    emitWorkspaceUpdateForCwd: [],
    handleWorkspaceGitBranchSnapshot: [],
    renameCurrentBranch: [],
    checkoutExistingBranch: [],
  };
  const generatorCalls: RecordedGeneratorCalls = {
    generateCommitMessage: [],
    generatePullRequestText: [],
  };
  const host: CheckoutSessionHost = {
    emit: (msg) => emitted.push(msg),
    notifyGitMutation: async (cwd, reason, opts) => {
      hostCalls.notifyGitMutation.push({ cwd, reason, options: opts });
    },
    emitWorkspaceUpdateForCwd: async (cwd) => {
      hostCalls.emitWorkspaceUpdateForCwd.push(cwd);
    },
    handleWorkspaceGitBranchSnapshot: (cwd, branchName) => {
      hostCalls.handleWorkspaceGitBranchSnapshot.push({ cwd, branchName });
    },
    renameCurrentBranch: async (cwd, branch) => {
      hostCalls.renameCurrentBranch.push({ cwd, branch });
      return { previousBranch: null, currentBranch: branch };
    },
    checkoutExistingBranch: async (cwd, branch) => {
      hostCalls.checkoutExistingBranch.push({ cwd, branch });
      return { source: "local" };
    },
    ...options?.host,
  };
  const gitMetadataGenerator: GitMetadataGenerator = {
    generateCommitMessage: async (cwd) => {
      generatorCalls.generateCommitMessage.push(cwd);
      return "";
    },
    generatePullRequestText: async (cwd, baseRef) => {
      generatorCalls.generatePullRequestText.push({ cwd, baseRef });
      return { title: "", body: "" };
    },
    ...options?.gitMetadataGenerator,
  };
  const github: GitHubService = { ...createGitHubService(), ...options?.github };
  const checkout = new CheckoutSession({
    host,
    workspaceGitService: createNoopWorkspaceGitService(options?.git),
    github,
    checkoutDiffManager:
      options?.diff ?? createFakeDiffSubscriber({ cwd: "", files: [], error: null }).subscriber,
    gitMetadataGenerator,
    paseoHome: "/tmp/paseo-home",
    worktreesRoot: undefined,
    logger: pino({ level: "silent" }),
  });
  return { checkout, emitted, hostCalls, generatorCalls };
}

function createGitSnapshot(
  cwd: string,
  currentBranch: string,
  overrides?: { isDirty?: boolean },
): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: cwd,
      currentBranch,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: overrides?.isDirty ?? false,
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

  describe("switch branch", () => {
    it("checks out the branch, refreshes the diff and workspace, then confirms success", async () => {
      const { subscriber, refreshedCwds } = createFakeDiffSubscriber({
        cwd: "",
        files: [],
        error: null,
      });
      const { checkout, emitted, hostCalls } = makeCheckoutSession({ diff: subscriber });

      await checkout.handleCheckoutSwitchBranchRequest({
        type: "checkout_switch_branch_request",
        cwd: "/repo",
        branch: "feature",
        requestId: "sw1",
      });

      expect(hostCalls.checkoutExistingBranch).toEqual([{ cwd: "/repo", branch: "feature" }]);
      expect(refreshedCwds).toEqual(["/repo"]);
      expect(hostCalls.emitWorkspaceUpdateForCwd).toEqual(["/repo"]);
      expect(emitted).toEqual([
        {
          type: "checkout_switch_branch_response",
          payload: {
            cwd: "/repo",
            success: true,
            branch: "feature",
            source: "local",
            error: null,
            requestId: "sw1",
          },
        },
      ]);
    });

    it("emits an error response when the checkout fails", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        host: {
          checkoutExistingBranch: async () => {
            throw new Error("branch missing");
          },
        },
      });

      await checkout.handleCheckoutSwitchBranchRequest({
        type: "checkout_switch_branch_request",
        cwd: "/repo",
        branch: "ghost",
        requestId: "sw2",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_switch_branch_response",
          payload: {
            cwd: "/repo",
            success: false,
            branch: "ghost",
            error: { code: "UNKNOWN", message: "branch missing" },
            requestId: "sw2",
          },
        },
      ]);
    });
  });

  describe("rename branch", () => {
    it("rejects an invalid slug without renaming", async () => {
      const { checkout, emitted, hostCalls } = makeCheckoutSession();

      await checkout.handleCheckoutRenameBranchRequest({
        type: "checkout.rename_branch.request",
        cwd: "/repo",
        branch: "bad branch!",
        requestId: "rn1",
      });

      expect(hostCalls.renameCurrentBranch).toEqual([]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "checkout.rename_branch.response",
        payload: { cwd: "/repo", success: false, currentBranch: null, requestId: "rn1" },
      });
    });

    it("renames, refreshes git state, and confirms the new branch", async () => {
      const { subscriber, refreshedCwds } = createFakeDiffSubscriber({
        cwd: "",
        files: [],
        error: null,
      });
      const { checkout, emitted, hostCalls } = makeCheckoutSession({ diff: subscriber });

      await checkout.handleCheckoutRenameBranchRequest({
        type: "checkout.rename_branch.request",
        cwd: "/repo",
        branch: "feature-renamed",
        requestId: "rn2",
      });

      expect(hostCalls.renameCurrentBranch).toEqual([{ cwd: "/repo", branch: "feature-renamed" }]);
      expect(hostCalls.notifyGitMutation).toEqual([
        { cwd: "/repo", reason: "rename-branch", options: { invalidateGithub: true } },
      ]);
      expect(refreshedCwds).toEqual(["/repo"]);
      expect(hostCalls.handleWorkspaceGitBranchSnapshot).toEqual([
        { cwd: "/repo", branchName: "feature-renamed" },
      ]);
      expect(hostCalls.emitWorkspaceUpdateForCwd).toEqual(["/repo"]);
      expect(emitted).toEqual([
        {
          type: "checkout.rename_branch.response",
          payload: {
            cwd: "/repo",
            success: true,
            currentBranch: "feature-renamed",
            error: null,
            requestId: "rn2",
          },
        },
      ]);
    });
  });

  describe("commit", () => {
    it("fails when no message is supplied and none can be generated", async () => {
      const { checkout, emitted, generatorCalls } = makeCheckoutSession();

      await checkout.handleCheckoutCommitRequest({
        type: "checkout_commit_request",
        cwd: "/repo",
        message: "",
        addAll: true,
        requestId: "c1",
      });

      expect(generatorCalls.generateCommitMessage).toEqual(["/repo"]);
      expect(emitted).toEqual([
        {
          type: "checkout_commit_response",
          payload: {
            cwd: "/repo",
            success: false,
            error: { code: "UNKNOWN", message: "Commit message is required" },
            requestId: "c1",
          },
        },
      ]);
    });
  });

  describe("merge preflight", () => {
    it("fails when the target is not a git repository", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { getSnapshot: async (cwd) => createNoGitWorkspaceRuntimeSnapshot(cwd) },
      });

      await checkout.handleCheckoutMergeRequest({
        type: "checkout_merge_request",
        cwd: "/repo",
        baseRef: "main",
        requestId: "m1",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_merge_response",
          payload: {
            cwd: "/repo",
            success: false,
            error: { code: "UNKNOWN", message: "Not a git repository: /repo" },
            requestId: "m1",
          },
        },
      ]);
    });

    it("fails a clean-required merge when the working tree is dirty", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { getSnapshot: async () => createGitSnapshot("/repo", "feature", { isDirty: true }) },
      });

      await checkout.handleCheckoutMergeRequest({
        type: "checkout_merge_request",
        cwd: "/repo",
        baseRef: "main",
        requireCleanTarget: true,
        requestId: "m2",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_merge_response",
          payload: {
            cwd: "/repo",
            success: false,
            error: { code: "UNKNOWN", message: "Working directory has uncommitted changes." },
            requestId: "m2",
          },
        },
      ]);
    });
  });

  describe("pr merge", () => {
    it("fails when no pull request number can be determined", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { getSnapshot: async (cwd) => createGitSnapshot(cwd, "feature") },
      });

      await checkout.handleCheckoutPrMergeRequest({
        type: "checkout_pr_merge_request",
        cwd: "/repo",
        mergeMethod: "merge",
        requestId: "pm1",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_pr_merge_response",
          payload: {
            cwd: "/repo",
            success: false,
            error: {
              code: "UNKNOWN",
              message: "Unable to determine GitHub pull request number for merge",
            },
            requestId: "pm1",
          },
        },
      ]);
    });
  });

  describe("stash list", () => {
    it("returns stash entries scoped to paseo stashes by default", async () => {
      const listStashesCalls: Array<{ cwd: string; paseoOnly: boolean | undefined }> = [];
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          listStashes: async (cwd, opts) => {
            listStashesCalls.push({ cwd, paseoOnly: opts?.paseoOnly });
            return [];
          },
        },
      });

      await checkout.handleStashListRequest({
        type: "stash_list_request",
        cwd: "/repo",
        requestId: "sl1",
      });

      expect(listStashesCalls).toEqual([{ cwd: "/repo", paseoOnly: true }]);
      expect(emitted).toEqual([
        {
          type: "stash_list_response",
          payload: { cwd: "/repo", entries: [], error: null, requestId: "sl1" },
        },
      ]);
    });
  });

  describe("pr status", () => {
    it("builds a pr status response from the git snapshot", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: { getSnapshot: async (cwd) => createGitSnapshot(cwd, "main") },
      });

      await checkout.handleCheckoutPrStatusRequest({
        type: "checkout_pr_status_request",
        cwd: "/repo",
        requestId: "ps1",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_pr_status_response",
          payload: expect.objectContaining({ cwd: "/repo", requestId: "ps1" }),
        },
      ]);
    });
  });

  describe("github search", () => {
    it("returns search results and the github-features flag", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: false }),
        },
      });

      await checkout.handleGitHubSearchRequest({
        type: "github_search_request",
        cwd: "/repo",
        query: "fix",
        requestId: "gs1",
      });

      expect(emitted).toEqual([
        {
          type: "github_search_response",
          payload: {
            items: [],
            githubFeaturesEnabled: false,
            error: null,
            requestId: "gs1",
          },
        },
      ]);
    });
  });
});
