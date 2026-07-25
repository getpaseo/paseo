import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  type CheckoutDiffSubscriber,
  CheckoutSession,
  type CheckoutSessionHost,
} from "./checkout-session.js";
import type { GitMutationService } from "../git-mutation/git-mutation-service.js";
import { createGitHubService } from "../../../services/github-service.js";
import { ForgeCliMissingError } from "../../../services/forge-cli-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
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

function isCheckDetailsResponse(msg: SessionOutboundMessage): boolean {
  return msg.type === "checkout.forge.get_check_details.response";
}

function isTimelineResponse(msg: SessionOutboundMessage): boolean {
  return msg.type === "pull_request_timeline_response";
}

interface FakeDiffSubscription {
  cwd: string;
  compare: CheckoutDiffCompareInput;
  emit(snapshot: CheckoutDiffSnapshotPayload): void;
  unsubscribeCalls: number;
}

function createFakeDiffSubscriber(initial: CheckoutDiffSnapshotPayload) {
  const subscriptions: FakeDiffSubscription[] = [];
  const refreshedCwds: string[] = [];
  const subscriber: CheckoutDiffSubscriber = {
    subscribe: async (params, listener) => {
      let isSubscribed = true;
      const subscription: FakeDiffSubscription = {
        cwd: params.cwd,
        compare: params.compare,
        unsubscribeCalls: 0,
        emit: (snapshot) => {
          if (isSubscribed) {
            listener(snapshot);
          }
        },
      };
      const unsubscribe = () => {
        if (!isSubscribed) {
          return;
        }
        isSubscribed = false;
        subscription.unsubscribeCalls += 1;
      };
      params.signal?.addEventListener("abort", unsubscribe, { once: true });
      subscriptions.push(subscription);
      return {
        initial: { ...initial, cwd: params.cwd },
        unsubscribe,
      };
    },
    scheduleRefreshForCwd: (cwd) => {
      refreshedCwds.push(cwd);
    },
  };
  return { subscriber, subscriptions, refreshedCwds };
}

interface RecordedHostCalls {
  emitWorkspaceUpdateForCwd: string[];
  handleWorkspaceGitBranchSnapshot: Array<{ cwd: string; branchName: string | null }>;
  renameCurrentBranch: Array<{ cwd: string; branch: string }>;
}

type GitMutationFake = Pick<GitMutationService, "checkoutExistingBranch" | "notifyGitMutation">;

interface RecordedGitMutationCalls {
  notifyGitMutation: Array<{
    cwd: string;
    reason: string;
    options?: { invalidateForge?: boolean };
  }>;
  checkoutExistingBranch: Array<{ cwd: string; branch: string }>;
}

interface RecordedGeneratorCalls {
  generateCommitMessage: string[];
  generatePullRequestText: Array<{ cwd: string; baseRef?: string }>;
}

function makeCheckoutSession(options?: {
  git?: Partial<WorkspaceGitService>;
  diff?: CheckoutDiffSubscriber;
  github?: Partial<ForgeService>;
  host?: Partial<CheckoutSessionHost>;
  gitMutation?: Partial<GitMutationFake>;
  gitMetadataGenerator?: Partial<GitMetadataGenerator>;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const hostCalls: RecordedHostCalls = {
    emitWorkspaceUpdateForCwd: [],
    handleWorkspaceGitBranchSnapshot: [],
    renameCurrentBranch: [],
  };
  const gitMutationCalls: RecordedGitMutationCalls = {
    notifyGitMutation: [],
    checkoutExistingBranch: [],
  };
  const generatorCalls: RecordedGeneratorCalls = {
    generateCommitMessage: [],
    generatePullRequestText: [],
  };
  const host: CheckoutSessionHost = {
    emit: (msg) => emitted.push(msg),
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
    ...options?.host,
  };
  const gitMutation: GitMutationFake = {
    notifyGitMutation: async (cwd, reason, opts) => {
      gitMutationCalls.notifyGitMutation.push({ cwd, reason, options: opts });
    },
    checkoutExistingBranch: async (cwd, branch) => {
      gitMutationCalls.checkoutExistingBranch.push({ cwd, branch });
      return { source: "local" };
    },
    ...options?.gitMutation,
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
  const github: ForgeService = { ...createGitHubService(), ...options?.github };
  const checkout = new CheckoutSession({
    host,
    gitMutation,
    workspaceGitService: createNoopWorkspaceGitService(options?.git),
    github,
    checkoutDiffManager:
      options?.diff ?? createFakeDiffSubscriber({ cwd: "", files: [], error: null }).subscriber,
    gitMetadataGenerator,
    paseoHome: "/tmp/paseo-home",
    worktreesRoot: undefined,
    logger: pino({ level: "silent" }),
  });
  return { checkout, emitted, hostCalls, gitMutationCalls, generatorCalls };
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
    forge: { featuresEnabled: false, pullRequest: null, error: null },
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
        { cwd: "/repo", options: { force: true, includeForge: true, reason: "manual-refresh" } },
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

      subscriptions[0].emit({
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
      const { checkout, emitted, hostCalls, gitMutationCalls } = makeCheckoutSession({
        diff: subscriber,
      });

      await checkout.handleCheckoutSwitchBranchRequest({
        type: "checkout_switch_branch_request",
        cwd: "/repo",
        branch: "feature",
        requestId: "sw1",
      });

      expect(gitMutationCalls.checkoutExistingBranch).toEqual([
        { cwd: "/repo", branch: "feature" },
      ]);
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
        gitMutation: {
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
      const { checkout, emitted, hostCalls, gitMutationCalls } = makeCheckoutSession({
        diff: subscriber,
      });

      await checkout.handleCheckoutRenameBranchRequest({
        type: "checkout.rename_branch.request",
        cwd: "/repo",
        branch: "feature-renamed",
        requestId: "rn2",
      });

      expect(hostCalls.renameCurrentBranch).toEqual([{ cwd: "/repo", branch: "feature-renamed" }]);
      expect(gitMutationCalls.notifyGitMutation).toEqual([
        { cwd: "/repo", reason: "rename-branch", options: { invalidateForge: true } },
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
              message: "Unable to determine current change request number for merge",
            },
            requestId: "pm1",
          },
        },
      ]);
    });
  });

  describe("auto-merge routing", () => {
    function createGitLabPrSnapshot(
      cwd: string,
      mergeWhenPipelineSucceeds: boolean,
    ): WorkspaceGitRuntimeSnapshot {
      return {
        ...createGitSnapshot(cwd, "feature/gitlab-auto-merge"),
        forge: {
          featuresEnabled: true,
          error: null,
          pullRequest: {
            number: 14,
            url: "https://gitlab.example.com/g/r/-/merge_requests/14",
            title: "GitLab MR",
            state: "open",
            baseRefName: "main",
            headRefName: "feature/gitlab-auto-merge",
            isMerged: false,
            isDraft: false,
            mergeable: "UNKNOWN",
            checks: [],
            checksStatus: "pending",
            reviewDecision: null,
            forgeSpecific: {
              forge: "gitlab",
              detailedMergeStatus: "ci_still_running",
              hasConflicts: false,
              blockingDiscussionsResolved: true,
              approvalsRequired: 0,
              approvalsGiven: 0,
              pipelineStatus: "running",
              pipelineId: 306,
              pipelineUrl: "https://gitlab.example.com/g/r/-/pipelines/306",
              mergeWhenPipelineSucceeds,
            },
          },
        },
      };
    }

    it("routes GitLab set-auto-merge enable and disable through the resolved adapter", async () => {
      const githubCalls: string[] = [];
      const gitlabCalls: Array<{ operation: "enable" | "disable"; prNumber: number }> = [];
      const gitlabService: Partial<ForgeService> = {
        async enablePullRequestAutoMerge(input) {
          gitlabCalls.push({ operation: "enable", prNumber: input.prNumber });
          return { success: true };
        },
        async disablePullRequestAutoMerge(input) {
          gitlabCalls.push({ operation: "disable", prNumber: input.prNumber });
          return { success: true };
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          async enablePullRequestAutoMerge() {
            githubCalls.push("enable");
            throw new Error("github adapter should not be reached for a gitlab cwd");
          },
          async disablePullRequestAutoMerge() {
            githubCalls.push("disable");
            throw new Error("github adapter should not be reached for a gitlab cwd");
          },
        },
        git: {
          getSnapshot: async (cwd) => createGitLabPrSnapshot(cwd, false),
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handleCheckoutForgeSetAutoMergeRequest({
        type: "checkout.forge.set_auto_merge.request",
        cwd: "/repo",
        enabled: true,
        mergeMethod: "squash",
        requestId: "am-enable",
      });
      await checkout.handleCheckoutForgeSetAutoMergeRequest({
        type: "checkout.forge.set_auto_merge.request",
        cwd: "/repo",
        enabled: false,
        requestId: "am-disable",
      });

      expect(githubCalls).toEqual([]);
      expect(gitlabCalls).toEqual([
        { operation: "enable", prNumber: 14 },
        { operation: "disable", prNumber: 14 },
      ]);
      expect(emitted).toEqual([
        {
          type: "checkout.forge.set_auto_merge.response",
          payload: {
            cwd: "/repo",
            enabled: true,
            success: true,
            error: null,
            requestId: "am-enable",
          },
        },
        {
          type: "checkout.forge.set_auto_merge.response",
          payload: {
            cwd: "/repo",
            enabled: false,
            success: true,
            error: null,
            requestId: "am-disable",
          },
        },
      ]);
    });
  });

  describe("check details routing", () => {
    it("routes get-check-details through the resolved GitLab adapter", async () => {
      const githubCalls: number[] = [];
      const gitlabCalls: Array<{ cwd: string; checkRunId: number }> = [];
      const gitlabService: Partial<ForgeService> = {
        async getCheckDetails(input) {
          gitlabCalls.push({ cwd: input.cwd, checkRunId: input.checkRunId });
          return {
            checkRunId: input.checkRunId,
            name: "Pipeline (feat/x)",
            annotations: [],
            failedJobs: [],
            truncated: false,
            pipeline: {
              id: input.checkRunId,
              status: "success",
              rawStatus: "success",
              url: "https://gitlab.example.com/g/r/-/pipelines/306",
              ref: "feat/x",
              sha: "abc",
              stages: [
                {
                  name: "test",
                  status: "success",
                  jobs: [
                    {
                      id: 1,
                      name: "unit",
                      stage: "test",
                      status: "success",
                      rawStatus: "success",
                      url: null,
                      allowFailure: false,
                      durationSeconds: 4,
                    },
                  ],
                },
              ],
            },
          };
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          async getCheckDetails(input) {
            githubCalls.push(input.checkRunId);
            throw new Error("github adapter should not be reached for a gitlab cwd");
          },
        },
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handleCheckoutForgeGetCheckDetailsRequest({
        type: "checkout.forge.get_check_details.request",
        cwd: "/repo",
        checkRunId: 306,
        requestId: "cd1",
      });

      expect(githubCalls).toEqual([]);
      expect(gitlabCalls).toEqual([{ cwd: "/repo", checkRunId: 306 }]);
      const response = emitted.find(isCheckDetailsResponse);
      expect(response).toMatchObject({
        payload: {
          success: true,
          details: { pipeline: { id: 306, stages: [{ name: "test" }] } },
        },
      });
    });
  });

  describe("timeline routing", () => {
    it("routes the timeline request through the resolved GitLab adapter", async () => {
      const gitlabCalls: Array<{ cwd: string; prNumber: number }> = [];
      const gitlabService: Partial<ForgeService> = {
        async isAuthenticated() {
          return true;
        },
        async getPullRequestTimeline(input) {
          gitlabCalls.push({ cwd: input.cwd, prNumber: input.prNumber });
          return {
            prNumber: input.prNumber,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            items: [
              {
                kind: "comment",
                id: "401",
                author: "reviewer-a",
                authorUrl: "https://gl/reviewer-a",
                avatarUrl: null,
                body: "Looks good",
                createdAt: 1710000000000,
                url: "https://gl/g/r/-/merge_requests/14#note_401",
              },
            ],
            truncated: false,
            error: null,
          };
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          async isAuthenticated() {
            throw new Error("github adapter should not be reached for a gitlab cwd");
          },
          async getPullRequestTimeline() {
            throw new Error("github adapter should not be reached for a gitlab cwd");
          },
        },
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl1",
      });

      expect(gitlabCalls).toEqual([{ cwd: "/repo", prNumber: 14 }]);
      const response = emitted.find(isTimelineResponse);
      expect(response).toMatchObject({
        payload: {
          prNumber: 14,
          items: [{ id: "401", kind: "comment", author: "reviewer-a" }],
          githubFeaturesEnabled: true,
          error: null,
        },
      });
    });

    it("routes the timeline request through the resolved Gitea adapter", async () => {
      const giteaCalls: Array<{ cwd: string; prNumber: number }> = [];
      const giteaService: Partial<ForgeService> = {
        async isAuthenticated() {
          return true;
        },
        async getPullRequestTimeline(input) {
          giteaCalls.push({ cwd: input.cwd, prNumber: input.prNumber });
          return {
            prNumber: input.prNumber,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            items: [
              {
                kind: "review",
                id: "2001",
                author: "reviewer-a",
                authorUrl: "https://gitea.com/reviewer-a",
                avatarUrl: null,
                body: "Approved",
                createdAt: 1710000000000,
                url: "https://gitea.com/g/r/pulls/12#issuecomment-2001",
                reviewState: "approved",
              },
            ],
            truncated: false,
            error: null,
          };
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          async isAuthenticated() {
            throw new Error("github adapter should not be reached for a gitea cwd");
          },
          async getPullRequestTimeline() {
            throw new Error("github adapter should not be reached for a gitea cwd");
          },
        },
        git: {
          resolveForge: async () => ({
            forge: "gitea",
            host: "gitea.com",
            service: giteaService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 12,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl-gitea",
      });

      expect(giteaCalls).toEqual([{ cwd: "/repo", prNumber: 12 }]);
      const response = emitted.find(isTimelineResponse);
      expect(response).toMatchObject({
        payload: {
          prNumber: 12,
          items: [{ id: "2001", kind: "review", author: "reviewer-a" }],
          githubFeaturesEnabled: true,
          error: null,
        },
      });
    });

    it("derives the unauthenticated timeline error label from the forge brand for GitLab", async () => {
      const gitlabService: Partial<ForgeService> = {
        async isAuthenticated() {
          return false;
        },
        async getPullRequestTimeline() {
          throw new Error("timeline fetch should not run while unauthenticated");
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl2",
      });

      const unauthenticatedResponse = emitted.find(isTimelineResponse);
      expect(unauthenticatedResponse).toMatchObject({
        payload: {
          githubFeaturesEnabled: false,
          error: {
            kind: "unknown",
            message: "GitLab CLI is unavailable or not authenticated",
          },
        },
      });
      expect(unauthenticatedResponse?.payload).not.toHaveProperty("authState");
    });

    it("carries the precise authState when the auth probe throws a classified error", async () => {
      const githubService: Partial<ForgeService> = {
        async isAuthenticated() {
          throw new ForgeCliMissingError("gh not found");
        },
        async getPullRequestTimeline() {
          throw new Error("timeline fetch should not run while unauthenticated");
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          resolveForge: async () => ({
            forge: "github",
            host: "github.com",
            service: githubService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl-cli-missing",
      });

      expect(emitted.find(isTimelineResponse)).toMatchObject({
        payload: {
          githubFeaturesEnabled: false,
          authState: "cli_missing",
        },
      });
    });

    it("keeps features enabled when the timeline fetch fails for non-auth reasons", async () => {
      const gitlabService: Partial<ForgeService> = {
        async isAuthenticated() {
          return true;
        },
        async getPullRequestTimeline() {
          throw new Error("glab timed out");
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl-error",
      });

      expect(emitted.find(isTimelineResponse)).toMatchObject({
        payload: {
          githubFeaturesEnabled: true,
          error: {
            kind: "unknown",
            message: "glab timed out",
          },
          authState: "error",
        },
      });
    });

    it("reports features disabled with the precise authState when the timeline fetch hits an auth error", async () => {
      const gitlabService: Partial<ForgeService> = {
        async isAuthenticated() {
          return true;
        },
        async getPullRequestTimeline() {
          throw new ForgeCliMissingError("glab not found");
        },
      };
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: gitlabService as ForgeService,
          }),
        },
      });

      await checkout.handlePullRequestTimelineRequest({
        type: "pull_request_timeline_request",
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "g",
        repoName: "r",
        requestId: "tl-fetch-auth-error",
      });

      expect(emitted.find(isTimelineResponse)).toMatchObject({
        payload: {
          githubFeaturesEnabled: false,
          authState: "cli_missing",
        },
      });
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

    it("reports non-auth status errors as errors instead of sign-in setup", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        git: {
          getSnapshot: async () => {
            throw new Error("glab returned invalid JSON");
          },
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.example.com",
            service: {} as ForgeService,
          }),
        },
      });

      await checkout.handleCheckoutPrStatusRequest({
        type: "checkout_pr_status_request",
        cwd: "/repo",
        requestId: "ps-error",
      });

      expect(emitted).toEqual([
        {
          type: "checkout_pr_status_response",
          payload: expect.objectContaining({
            cwd: "/repo",
            status: null,
            githubFeaturesEnabled: true,
            authState: "error",
            forge: "gitlab",
            requestId: "ps-error",
            error: expect.objectContaining({ message: "glab returned invalid JSON" }),
          }),
        },
      ]);
    });

    it("resolves the forge once when reporting a non-auth status error", async () => {
      let resolveForgeCalls = 0;
      const resolveForge: WorkspaceGitService["resolveForge"] = async () => {
        resolveForgeCalls += 1;
        return { forge: "gitlab", host: "gitlab.example.com", service: {} as ForgeService };
      };
      const { checkout } = makeCheckoutSession({
        git: {
          getSnapshot: async () => {
            throw new Error("glab returned invalid JSON");
          },
          resolveForge,
        },
      });

      await checkout.handleCheckoutPrStatusRequest({
        type: "checkout_pr_status_request",
        cwd: "/repo",
        requestId: "ps-error-2",
      });

      expect(resolveForgeCalls).toBe(1);
    });
  });

  describe("github search", () => {
    it("returns search results and the github-features flag", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          searchIssuesAndPrs: async () => ({
            items: [],
            featuresEnabled: false,
            authState: "unauthenticated",
            githubFeaturesEnabled: false,
          }),
        },
      });

      await checkout.handleForgeSearchRequest({
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
            featuresEnabled: false,
            authState: "unauthenticated",
            githubFeaturesEnabled: false,
            error: null,
            requestId: "gs1",
          },
        },
      ]);
    });

    it("converts neutral change-request items for the legacy github search response", async () => {
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          searchIssuesAndPrs: async () => ({
            items: [
              {
                kind: "change_request",
                number: 17,
                title: "Fix search",
                url: "https://github.com/acme/repo/pull/17",
                state: "open",
                body: null,
                labels: ["bug"],
                baseRefName: "main",
                headRefName: "fix-search",
                updatedAt: "2026-06-28T10:00:00.000Z",
              },
              {
                kind: "issue",
                number: 22,
                title: "Track search",
                url: "https://github.com/acme/repo/issues/22",
                state: "open",
                body: null,
                labels: ["triage"],
                baseRefName: null,
                headRefName: null,
                updatedAt: "2026-06-28T11:00:00.000Z",
              },
            ],
            featuresEnabled: true,
            authState: "authenticated",
            githubFeaturesEnabled: true,
          }),
        },
      });

      await checkout.handleForgeSearchRequest({
        type: "github_search_request",
        cwd: "/repo",
        query: "fix",
        requestId: "gs-legacy-items",
      });

      expect(emitted).toEqual([
        {
          type: "github_search_response",
          payload: {
            items: [
              {
                kind: "pr",
                forge: "github",
                number: 17,
                title: "Fix search",
                url: "https://github.com/acme/repo/pull/17",
                state: "open",
                body: null,
                labels: ["bug"],
                baseRefName: "main",
                headRefName: "fix-search",
                updatedAt: "2026-06-28T10:00:00.000Z",
              },
              {
                kind: "issue",
                forge: "github",
                number: 22,
                title: "Track search",
                url: "https://github.com/acme/repo/issues/22",
                state: "open",
                body: null,
                labels: ["triage"],
                baseRefName: null,
                headRefName: null,
                updatedAt: "2026-06-28T11:00:00.000Z",
              },
            ],
            featuresEnabled: true,
            authState: "authenticated",
            githubFeaturesEnabled: true,
            error: null,
            requestId: "gs-legacy-items",
          },
        },
      ]);
    });

    it("routes search through the resolved GitLab service without running gh", async () => {
      let githubCalled = false;
      const gitlabSearches: unknown[] = [];
      const { checkout, emitted } = makeCheckoutSession({
        github: {
          searchIssuesAndPrs: async () => {
            githubCalled = true;
            return {
              items: [],
              featuresEnabled: true,
              authState: "authenticated",
              githubFeaturesEnabled: true,
            };
          },
        },
        git: {
          resolveForge: async () => ({
            forge: "gitlab",
            host: "gitlab.com",
            service: {
              searchIssuesAndPrs: async (input) => {
                gitlabSearches.push(input);
                return {
                  items: [
                    {
                      kind: "change_request",
                      number: 17,
                      title: "GitLab result",
                      url: "https://gitlab.com/acme/repo/-/merge_requests/17",
                      state: "opened",
                      body: null,
                      labels: [],
                      baseRefName: "main",
                      headRefName: "feature",
                      updatedAt: "2026-06-28T10:00:00.000Z",
                    },
                  ],
                  featuresEnabled: true,
                  authState: "authenticated",
                  githubFeaturesEnabled: true,
                };
              },
            } as never,
          }),
        },
      });

      await checkout.handleForgeSearchRequest({
        type: "forge.search.request",
        cwd: "/repo",
        query: "fix",
        requestId: "gs2",
      });

      expect(githubCalled).toBe(false);
      expect(gitlabSearches).toEqual([
        {
          cwd: "/repo",
          query: "fix",
          limit: undefined,
          kinds: undefined,
        },
      ]);
      expect(emitted).toEqual([
        {
          type: "forge.search.response",
          payload: {
            items: [
              {
                kind: "change_request",
                forge: "gitlab",
                number: 17,
                title: "GitLab result",
                url: "https://gitlab.com/acme/repo/-/merge_requests/17",
                state: "opened",
                body: null,
                labels: [],
                baseRefName: "main",
                headRefName: "feature",
                updatedAt: "2026-06-28T10:00:00.000Z",
              },
            ],
            authState: "authenticated",
            error: null,
            requestId: "gs2",
          },
        },
      ]);
    });
  });
});
