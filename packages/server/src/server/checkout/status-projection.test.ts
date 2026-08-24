import { describe, expect, test } from "vitest";

import { CheckoutPrStatusSchema } from "@getpaseo/protocol/messages";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import {
  buildCheckoutPrStatusPayloadFromSnapshot,
  normalizeCheckoutPrStatusPayload,
} from "./status-projection.js";

describe("checkout status projection", () => {
  test("includes repository identity fields on the PR status wire payload", () => {
    const payload = normalizeCheckoutPrStatusPayload(
      {
        number: 123,
        repoOwner: "internal-owner",
        repoName: "internal-repo",
        url: "https://github.com/getpaseo/paseo/pull/123",
        title: "Ship PR pane",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/pr-pane",
        isMerged: false,
        isDraft: true,
        mergeable: "MERGEABLE",
        checks: [
          {
            name: "typecheck",
            status: "success",
            url: "https://github.com/getpaseo/paseo/actions/runs/1",
            workflow: "CI",
            duration: "1m 20s",
          },
        ],
        checksStatus: "success",
        reviewDecision: "approved",
      },
      "github",
    );

    expect(payload).toHaveProperty("repoOwner", "internal-owner");
    expect(payload).toHaveProperty("repoName", "internal-repo");
    expect(payload).toHaveProperty("forge", "github");
    expect(payload).toHaveProperty("projectPath", "internal-owner/internal-repo");
    expect(payload).toHaveProperty("mergeable", "MERGEABLE");
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });

  test("projects PR 993 GitHub merge facts without changing top-level status fields", () => {
    const payload = normalizeCheckoutPrStatusPayload(
      {
        number: 993,
        repoOwner: "getpaseo",
        repoName: "paseo",
        url: "https://github.com/getpaseo/paseo/pull/993",
        title: "Auto-merge UX",
        state: "open",
        baseRefName: "main",
        headRefName: "github-pr-auto-merge-ux",
        isMerged: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        checks: [
          {
            name: "server tests",
            status: "pending",
            url: "https://github.com/getpaseo/paseo/actions/runs/993",
            workflow: "CI",
          },
        ],
        checksStatus: "pending",
        reviewDecision: "approved",
        forgeSpecific: {
          forge: "github",
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: true,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: false,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
      },
      "github",
    );

    expect(payload).toMatchObject({
      forge: "github",
      projectPath: "getpaseo/paseo",
      number: 993,
      mergeable: "MERGEABLE",
      checksStatus: "pending",
      forgeSpecific: {
        forge: "github",
        mergeStateStatus: "BLOCKED",
        viewerCanEnableAutoMerge: true,
      },
      // COMPAT(forgeSpecific): GitHub facts are still mirrored onto `github` for old clients.
      github: {
        mergeStateStatus: "BLOCKED",
        viewerCanEnableAutoMerge: true,
        repository: {
          autoMergeAllowed: true,
          squashMergeAllowed: true,
          viewerDefaultMergeMethod: "SQUASH",
        },
      },
    });
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });

  test("projects GitLab merge facts onto forgeSpecific without a github mirror", () => {
    const payload = normalizeCheckoutPrStatusPayload(
      {
        number: 1,
        repoOwner: "group",
        repoName: "repo",
        projectPath: "group/subgroup/repo",
        url: "https://gitlab.com/group/subgroup/repo/-/merge_requests/1",
        title: "Add sample change",
        state: "open",
        baseRefName: "main",
        headRefName: "feat/sample-change",
        isMerged: false,
        mergeable: "MERGEABLE",
        checksStatus: "success",
        forgeSpecific: {
          forge: "gitlab",
          detailedMergeStatus: "mergeable",
          hasConflicts: false,
          blockingDiscussionsResolved: true,
          approvalsRequired: 1,
          approvalsGiven: 1,
          pipelineStatus: "success",
          pipelineId: 306,
          pipelineUrl: "https://gitlab.com/group/subgroup/repo/-/pipelines/306",
          mergeWhenPipelineSucceeds: false,
        },
      },
      "gitlab",
    );

    expect(payload).toHaveProperty("projectPath", "group/subgroup/repo");
    expect(payload).toMatchObject({
      forgeSpecific: {
        forge: "gitlab",
        detailedMergeStatus: "mergeable",
        pipelineStatus: "success",
      },
    });
    expect(payload).not.toHaveProperty("github");
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });

  test("projects Gitea-family facts while preserving the resolved Forgejo brand", () => {
    const payload = normalizeCheckoutPrStatusPayload(
      {
        number: 5,
        repoOwner: "example",
        repoName: "repo",
        url: "https://codeberg.org/example/repo/pulls/5",
        title: "Add sample change",
        state: "open",
        baseRefName: "main",
        headRefName: "feat/sample-change",
        isMerged: false,
        mergeable: "MERGEABLE",
        checksStatus: "success",
        forgeSpecific: {
          forge: "gitea",
          mergeable: true,
          hasMerged: false,
          ciStatus: "success",
        },
      },
      "forgejo",
    );

    expect(payload).toMatchObject({
      forge: "forgejo",
      forgeSpecific: {
        forge: "gitea",
        mergeable: true,
        hasMerged: false,
        ciStatus: "success",
      },
    });
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });

  test("labels the nested status.forge with the resolved forge", () => {
    const payload = normalizeCheckoutPrStatusPayload(
      {
        number: 1,
        url: "https://gitlab.com/group/proj/-/merge_requests/1",
        title: "MR",
        state: "open",
        baseRefName: "main",
        headRefName: "feat/x",
        isMerged: false,
        mergeable: "MERGEABLE",
      },
      "gitlab",
    );
    expect(payload).toHaveProperty("forge", "gitlab");
  });

  test("a gitlab-resolved snapshot emits status.forge and payload forge as gitlab", () => {
    const snapshot = {
      git: { remoteUrl: "git@gitlab.com:group/proj.git" },
      forge: {
        featuresEnabled: true,
        authState: "authenticated",
        forge: "gitlab",
        error: null,
        pullRequest: {
          number: 7,
          url: "https://gitlab.com/group/proj/-/merge_requests/7",
          title: "MR 7",
          state: "open",
          baseRefName: "main",
          headRefName: "feat/seven",
          isMerged: false,
          mergeable: "MERGEABLE",
          forgeSpecific: {
            forge: "gitlab",
            detailedMergeStatus: "mergeable",
            hasConflicts: false,
            blockingDiscussionsResolved: true,
            approvalsRequired: 0,
            approvalsGiven: 0,
            pipelineStatus: "success",
            pipelineId: 307,
            pipelineUrl: "https://gitlab.com/group/proj/-/pipelines/307",
            mergeWhenPipelineSucceeds: false,
          },
        },
      },
    } as unknown as WorkspaceGitRuntimeSnapshot;

    const payload = buildCheckoutPrStatusPayloadFromSnapshot({
      cwd: "/repo",
      requestId: "req-1",
      snapshot,
    });

    expect(payload.forge).toBe("gitlab");
    expect(payload.status?.forge).toBe("gitlab");
  });

  test("an unresolved self-hosted remote projects as neutral unauthenticated", () => {
    const snapshot = {
      git: { remoteUrl: "https://git.internal/acme/repo.git" },
      forge: {
        featuresEnabled: false,
        authState: "unauthenticated",
        forge: "git.internal",
        error: null,
        pullRequest: null,
      },
    } as unknown as WorkspaceGitRuntimeSnapshot;

    const payload = buildCheckoutPrStatusPayloadFromSnapshot({
      cwd: "/repo",
      requestId: "req-neutral",
      snapshot,
    });

    expect(payload).toMatchObject({
      status: null,
      githubFeaturesEnabled: false,
      authState: "unauthenticated",
      forge: "git.internal",
      error: null,
      requestId: "req-neutral",
    });
  });

  test("a forgejo-resolved snapshot keeps Forgejo branding with Gitea-family facts", () => {
    const snapshot = {
      git: { remoteUrl: "git@codeberg.org:example/repo.git" },
      forge: {
        featuresEnabled: true,
        authState: "authenticated",
        forge: "forgejo",
        error: null,
        pullRequest: {
          number: 5,
          url: "https://codeberg.org/example/repo/pulls/5",
          title: "PR 5",
          state: "open",
          baseRefName: "main",
          headRefName: "feat/five",
          isMerged: false,
          mergeable: "MERGEABLE",
          forgeSpecific: {
            forge: "gitea",
            mergeable: true,
            hasMerged: false,
            ciStatus: "success",
          },
        },
      },
    } as unknown as WorkspaceGitRuntimeSnapshot;

    const payload = buildCheckoutPrStatusPayloadFromSnapshot({
      cwd: "/repo",
      requestId: "req-forgejo",
      snapshot,
    });

    expect(payload.forge).toBe("forgejo");
    expect(payload.status?.forge).toBe("forgejo");
    expect(payload.status?.forgeSpecific).toEqual({
      forge: "gitea",
      mergeable: true,
      hasMerged: false,
      ciStatus: "success",
    });
  });

  test("does not project a facts-family tag as the brand forge for unresolved snapshots", () => {
    const snapshot = {
      git: { remoteUrl: "git@codeberg.org:example/repo.git" },
      forge: {
        featuresEnabled: true,
        authState: "authenticated",
        error: null,
        pullRequest: {
          number: 5,
          url: "https://codeberg.org/example/repo/pulls/5",
          title: "PR 5",
          state: "open",
          baseRefName: "main",
          headRefName: "feat/five",
          isMerged: false,
          mergeable: "MERGEABLE",
          forgeSpecific: {
            forge: "gitea",
            mergeable: true,
            hasMerged: false,
            ciStatus: "success",
          },
        },
      },
    } as unknown as WorkspaceGitRuntimeSnapshot;

    const payload = buildCheckoutPrStatusPayloadFromSnapshot({
      cwd: "/repo",
      requestId: "req-unresolved",
      snapshot,
    });

    expect(payload.forge).toBeUndefined();
    expect(payload.status?.forge).toBeUndefined();
    expect(payload.status?.forgeSpecific).toEqual({
      forge: "gitea",
      mergeable: true,
      hasMerged: false,
      ciStatus: "success",
    });
  });
});
