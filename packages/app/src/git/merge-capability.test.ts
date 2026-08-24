import { describe, expect, it } from "vitest";

import { deriveMergeCapability, type ForgeSpecificStatusFacts } from "./merge-capability";

type GithubMergeFactsFixture = ForgeSpecificStatusFacts & {
  forge: "github";
  mergeStateStatus: string | null;
  autoMergeRequest: {
    enabledAt: string | null;
    mergeMethod: string | null;
    enabledBy: string | null;
  } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  viewerCanMergeAsAdmin: boolean;
  viewerCanUpdateBranch: boolean;
  repository: {
    autoMergeAllowed: boolean;
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    viewerDefaultMergeMethod: string | null;
  };
  isMergeQueueEnabled: boolean;
  isInMergeQueue: boolean;
};

type GitlabMergeFactsFixture = ForgeSpecificStatusFacts & {
  forge: "gitlab";
  detailedMergeStatus: string | null;
  hasConflicts: boolean;
  blockingDiscussionsResolved: boolean;
  approvalsRequired: number;
  approvalsGiven: number;
  pipelineStatus: string | null;
  pipelineId: number | null;
  pipelineUrl: string | null;
  mergeWhenPipelineSucceeds: boolean;
};

type GiteaMergeFactsFixture = ForgeSpecificStatusFacts & {
  forge: "gitea";
  mergeable: boolean;
  hasMerged: boolean;
  ciStatus: string | null;
};

function facts(overrides: Partial<GithubMergeFactsFixture> = {}): GithubMergeFactsFixture {
  return {
    forge: "github",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: false,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: false,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  };
}

function gitlabFacts(overrides: Partial<GitlabMergeFactsFixture> = {}): GitlabMergeFactsFixture {
  return {
    forge: "gitlab",
    detailedMergeStatus: "mergeable",
    hasConflicts: false,
    blockingDiscussionsResolved: true,
    approvalsRequired: 0,
    approvalsGiven: 0,
    pipelineStatus: "success",
    pipelineId: null,
    pipelineUrl: null,
    mergeWhenPipelineSucceeds: false,
    ...overrides,
  };
}

function giteaFacts(overrides: Partial<GiteaMergeFactsFixture> = {}): GiteaMergeFactsFixture {
  return {
    forge: "gitea",
    mergeable: true,
    hasMerged: false,
    ciStatus: "success",
    ...overrides,
  };
}

describe("deriveMergeCapability", () => {
  it("returns null when the forge supplied no merge facts", () => {
    expect(deriveMergeCapability(null)).toBeNull();
    expect(deriveMergeCapability(undefined)).toBeNull();
  });

  it("rejects untagged and schema-mismatched forge facts at the registry boundary", () => {
    expect(deriveMergeCapability({ approvalsRequired: 2 })).toBeNull();
    expect(
      deriveMergeCapability({
        ...gitlabFacts(),
        approvalsRequired: "two",
      }),
    ).toBeNull();
  });

  it("marks direct merge ready only for the GitHub clean states", () => {
    expect(deriveMergeCapability(facts({ mergeStateStatus: "CLEAN" }))?.directMergeReady).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: "HAS_HOOKS" }))?.directMergeReady).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: "BLOCKED" }))?.directMergeReady).toBe(
      false,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: null }))?.directMergeReady).toBe(false);
  });

  it("can enable auto-merge only when blocked, allowed, and the viewer may enable it", () => {
    const ready = facts({
      mergeStateStatus: "BLOCKED",
      viewerCanEnableAutoMerge: true,
      repository: {
        autoMergeAllowed: true,
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerDefaultMergeMethod: "SQUASH",
      },
    });
    expect(deriveMergeCapability(ready)?.canEnableAutoMerge).toBe(true);

    expect(
      deriveMergeCapability(facts({ ...ready, viewerCanEnableAutoMerge: false }))
        ?.canEnableAutoMerge,
    ).toBe(false);
    expect(
      deriveMergeCapability(facts({ ...ready, mergeStateStatus: "CLEAN" }))?.canEnableAutoMerge,
    ).toBe(false);
  });

  it("reports whether auto-merge is already enabled and can be disabled", () => {
    const cap = deriveMergeCapability(
      facts({
        autoMergeRequest: { enabledAt: "now", mergeMethod: "SQUASH", enabledBy: "octocat" },
        viewerCanDisableAutoMerge: true,
      }),
    );
    expect(cap?.autoMergeEnabled).toBe(true);
    expect(cap?.canDisableAutoMerge).toBe(true);
    expect(deriveMergeCapability(facts())?.autoMergeEnabled).toBe(false);
  });

  it("treats an enabled or in-progress merge queue as blocking", () => {
    expect(deriveMergeCapability(facts({ isMergeQueueEnabled: true }))?.mergeBlockedByQueue).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ isInMergeQueue: true }))?.mergeBlockedByQueue).toBe(true);
    expect(deriveMergeCapability(facts())?.mergeBlockedByQueue).toBe(false);
  });

  it("derives allowed methods and the preferred method from the repository policy", () => {
    const cap = deriveMergeCapability(
      facts({
        repository: {
          autoMergeAllowed: false,
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          viewerDefaultMergeMethod: "REBASE",
        },
      }),
    );
    expect(cap?.allowedMethods).toEqual(["squash", "rebase"]);
    expect(cap?.preferredMethod).toBe("rebase");
  });

  it("returns a null preferred method when the forge reports an unknown default", () => {
    expect(
      deriveMergeCapability(
        facts({ repository: { ...facts().repository, viewerDefaultMergeMethod: null } }),
      )?.preferredMethod,
    ).toBeNull();
  });
});

describe("deriveMergeCapability (legacy github fallback)", () => {
  it("synthesizes full GitHub capability from legacy status.github when forgeSpecific is absent", () => {
    const { forge: _forge, ...legacy } = facts({
      mergeStateStatus: "CLEAN",
      repository: {
        autoMergeAllowed: false,
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        viewerDefaultMergeMethod: "SQUASH",
      },
    });
    const cap = deriveMergeCapability(undefined, legacy);
    expect(cap).not.toBeNull();
    expect(cap?.directMergeReady).toBe(true);
    expect(cap?.allowedMethods).toEqual(["squash"]);
    expect(cap?.preferredMethod).toBe("squash");
  });

  it("returns null when both forgeSpecific and legacy github facts are absent", () => {
    expect(deriveMergeCapability(undefined, null)).toBeNull();
    expect(deriveMergeCapability(undefined, undefined)).toBeNull();
  });
});

describe("deriveMergeCapability (gitlab)", () => {
  it("produces a non-null capability for the gitlab arm", () => {
    expect(deriveMergeCapability(gitlabFacts())).not.toBeNull();
  });

  it("marks direct merge ready only when GitLab reports the mergeable status", () => {
    expect(
      deriveMergeCapability(gitlabFacts({ detailedMergeStatus: "mergeable" }))?.directMergeReady,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ detailedMergeStatus: "ci_still_running" }))
        ?.directMergeReady,
    ).toBe(false);
    expect(
      deriveMergeCapability(gitlabFacts({ detailedMergeStatus: "discussions_not_resolved" }))
        ?.directMergeReady,
    ).toBe(false);
    expect(
      deriveMergeCapability(gitlabFacts({ detailedMergeStatus: null }))?.directMergeReady,
    ).toBe(false);
  });

  it("reflects merge-when-pipeline-succeeds as an enabled auto-merge", () => {
    const enabled = deriveMergeCapability(
      gitlabFacts({ mergeWhenPipelineSucceeds: true, pipelineStatus: "running" }),
    );
    expect(enabled?.autoMergeEnabled).toBe(true);
    expect(enabled?.canDisableAutoMerge).toBe(true);
    expect(enabled?.canEnableAutoMerge).toBe(false);
    expect(deriveMergeCapability(gitlabFacts())?.autoMergeEnabled).toBe(false);
  });

  it("can enable auto-merge only while a pipeline is still in flight", () => {
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "created" }))?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "waiting_for_resource" }))
        ?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "preparing" }))?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "pending" }))?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "running" }))?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "scheduled" }))?.canEnableAutoMerge,
    ).toBe(true);
    expect(
      deriveMergeCapability(gitlabFacts({ pipelineStatus: "success" }))?.canEnableAutoMerge,
    ).toBe(false);
    expect(deriveMergeCapability(gitlabFacts({ pipelineStatus: null }))?.canEnableAutoMerge).toBe(
      false,
    );
  });

  it("offers GitLab merge methods and never reports a merge queue", () => {
    const cap = deriveMergeCapability(gitlabFacts());
    expect(cap?.allowedMethods).toEqual(["merge", "squash", "rebase"]);
    expect(cap?.mergeBlockedByQueue).toBe(false);
    expect(cap?.canEnableAutoMerge).toBe(false);
  });
});

describe("deriveMergeCapability (gitea)", () => {
  it("allows direct merge only when the pull request is mergeable and unmerged", () => {
    expect(deriveMergeCapability(giteaFacts())?.directMergeReady).toBe(true);
    expect(deriveMergeCapability(giteaFacts({ mergeable: false }))?.directMergeReady).toBe(false);
    expect(deriveMergeCapability(giteaFacts({ hasMerged: true }))?.directMergeReady).toBe(false);
  });

  it("offers direct merge styles without auto-merge", () => {
    const capability = deriveMergeCapability(giteaFacts());
    expect(capability?.allowedMethods).toEqual(["merge", "squash", "rebase"]);
    expect(capability?.canEnableAutoMerge).toBe(false);
    expect(capability?.autoMergeEnabled).toBe(false);
    expect(capability?.canDisableAutoMerge).toBe(false);
  });
});
