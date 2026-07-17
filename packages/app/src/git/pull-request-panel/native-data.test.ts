import { describe, expect, it } from "vitest";
import type { CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";
import {
  deriveGitlabApprovals,
  deriveGitlabPipelineSummary,
  type GitlabMergeFacts,
} from "@/git/forges/gitlab";
import { getNativeFallbackChecks } from "./native-data";

type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>;

function gitlabFacts(overrides: Partial<GitlabMergeFacts> = {}): GitlabMergeFacts {
  return {
    forge: "gitlab",
    detailedMergeStatus: "mergeable",
    mergeStatus: null,
    hasConflicts: false,
    blockingDiscussionsResolved: true,
    approvalsRequired: 0,
    approvalsGiven: 0,
    pipelineStatus: null,
    pipelineId: null,
    pipelineUrl: null,
    mergeWhenPipelineSucceeds: false,
    ...overrides,
  };
}

function status(forgeSpecific: CheckoutPrStatus["forgeSpecific"], url: string): CheckoutPrStatus {
  return {
    forge: "gitea",
    number: 7,
    url,
    title: "Native data",
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: false,
    isDraft: false,
    mergeable: "UNKNOWN",
    checks: [],
    reviewDecision: null,
    ...(forgeSpecific ? { forgeSpecific } : {}),
  };
}

describe("deriveGitlabPipelineSummary", () => {
  it("summarizes a head pipeline, mapping the raw status onto a check status", () => {
    expect(
      deriveGitlabPipelineSummary(
        gitlabFacts({
          pipelineStatus: "running",
          pipelineId: 306,
          pipelineUrl: "https://gitlab.com/group/repo/-/pipelines/306",
        }),
      ),
    ).toEqual({
      id: 306,
      status: "pending",
      rawStatus: "running",
      url: "https://gitlab.com/group/repo/-/pipelines/306",
    });
  });

  it("returns null when the MR has no head pipeline", () => {
    expect(deriveGitlabPipelineSummary(gitlabFacts({ pipelineId: null }))).toBeNull();
  });
});

describe("deriveGitlabApprovals", () => {
  it("surfaces N of M approvals", () => {
    expect(deriveGitlabApprovals(gitlabFacts({ approvalsRequired: 2, approvalsGiven: 1 }))).toEqual(
      {
        given: 1,
        required: 2,
      },
    );
  });

  it("returns null when no approvals are required", () => {
    expect(deriveGitlabApprovals(gitlabFacts({ approvalsRequired: 0 }))).toBeNull();
  });
});

describe("getNativeFallbackChecks", () => {
  it("surfaces the Gitea aggregate CI status branded with the top-level forge", () => {
    expect(
      getNativeFallbackChecks(
        status(
          { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: "success" },
          "https://gitea.com/group/repo/pulls/7",
        ),
        "gitea",
      ),
    ).toEqual([
      {
        provider: "gitea",
        name: "CI",
        status: "success",
        url: "https://gitea.com/group/repo/pulls/7",
      },
    ]);
  });

  it("keeps Forgejo branding for the Gitea-family aggregate check", () => {
    expect(
      getNativeFallbackChecks(
        status(
          { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: "failure" },
          "https://forgejo.example.com/group/repo/pulls/7",
        ),
        "forgejo",
      ),
    ).toEqual([
      {
        provider: "forgejo",
        name: "CI",
        status: "failure",
        url: "https://forgejo.example.com/group/repo/pulls/7",
      },
    ]);
  });

  it("maps a Gitea 'warning' aggregate to a failing fallback check, not pending", () => {
    expect(
      getNativeFallbackChecks(
        status(
          { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: "warning" },
          "https://gitea.com/group/repo/pulls/7",
        ),
        "gitea",
      ),
    ).toEqual([
      {
        provider: "gitea",
        name: "CI",
        status: "failure",
        url: "https://gitea.com/group/repo/pulls/7",
      },
    ]);
  });

  it("returns no fallback checks for a forge that reports none", () => {
    expect(
      getNativeFallbackChecks(
        status(
          { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: null },
          "https://gitea.com/group/repo/pulls/7",
        ),
        "gitea",
      ),
    ).toEqual([]);
    expect(
      getNativeFallbackChecks(
        status(gitlabFacts(), "https://gitlab.com/group/repo/-/merge_requests/7"),
        "gitlab",
      ),
    ).toEqual([]);
  });
});
