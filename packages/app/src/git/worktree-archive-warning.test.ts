import { describe, expect, it } from "vitest";

import {
  buildWorktreeArchiveConfirmationMessage,
  buildWorktreeArchiveRiskReasons,
  classifyOriginDefaultArchivePushRisk,
  formatOriginDefaultRelationLabel,
  toWorktreeArchiveRisk,
  type OriginDefaultRelation,
} from "@/git/worktree-archive-warning";

const included: OriginDefaultRelation = {
  state: "included",
  resolvedRef: "origin/main",
  ahead: 0,
  behind: 2,
  uniquePatchCount: 0,
};

const exact: OriginDefaultRelation = {
  state: "exact",
  resolvedRef: "origin/main",
  ahead: 0,
  behind: 0,
  uniquePatchCount: 0,
};

const patchEquivalent: OriginDefaultRelation = {
  state: "patch_equivalent_not_included",
  resolvedRef: "origin/main",
  ahead: 1,
  behind: 1,
  uniquePatchCount: 0,
};

const ahead: OriginDefaultRelation = {
  state: "ahead",
  resolvedRef: "origin/main",
  ahead: 2,
  behind: 0,
  uniquePatchCount: 2,
};

const diverged: OriginDefaultRelation = {
  state: "diverged_with_unique_commits",
  resolvedRef: "origin/main",
  ahead: 1,
  behind: 1,
  uniquePatchCount: 1,
};

const unverifiable: OriginDefaultRelation = {
  state: "unverifiable",
  resolvedRef: null,
  ahead: null,
  behind: null,
  uniquePatchCount: null,
};

describe("workspace archive warning for worktree backing", () => {
  it("does not require a confirmation for clean and pushed worktrees", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "feature",
        isDirty: false,
        aheadOfOrigin: 0,
        diffStat: null,
      }),
    ).toBeNull();
  });

  it("explains uncommitted line changes", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: true,
        aheadOfOrigin: 0,
        diffStat: { additions: 12, deletions: 1 },
      }),
    ).toEqual(["Uncommitted changes (12 added lines, 1 deleted line)"]);
  });

  it("treats nonzero diff stats as dirty when dirty state is missing", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: undefined,
        aheadOfOrigin: 0,
        diffStat: { additions: 4, deletions: 0 },
      }),
    ).toEqual(["Uncommitted changes (4 added lines)"]);
  });

  it("explains unpushed commits", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 2,
        diffStat: null,
      }),
    ).toEqual(["2 unpushed commits"]);
  });

  it("includes every archive risk in the confirmation copy", () => {
    expect(
      buildWorktreeArchiveConfirmationMessage({
        workspaceName: "risky-feature",
        isDirty: true,
        aheadOfOrigin: 1,
        diffStat: { additions: 1, deletions: 3 },
      }),
    ).toBe("Uncommitted changes (1 added line, 3 deleted lines)\n1 unpushed commit");
  });

  it("maps archive workspace fields into the shared worktree risk shape", () => {
    expect(
      toWorktreeArchiveRisk({
        archiveHasUncommittedChanges: true,
        archiveUnpushedCommitCount: 3,
        archiveOriginDefaultRelation: included,
        diffStat: { additions: 2, deletions: 1 },
      }),
    ).toEqual({
      isDirty: true,
      aheadOfOrigin: 3,
      originDefaultRelation: included,
      diffStat: { additions: 2, deletions: 1 },
    });
  });

  it("does not treat exact/included as unpushed risk even when aheadOfOrigin is positive", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 3,
        originDefaultRelation: included,
        diffStat: null,
      }),
    ).toEqual([]);
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 1,
        originDefaultRelation: exact,
        diffStat: null,
      }),
    ).toEqual([]);
    expect(classifyOriginDefaultArchivePushRisk(included)).toBe("included");
    expect(classifyOriginDefaultArchivePushRisk(exact)).toBe("included");
  });

  it("labels exact/included as Included in origin/<default>", () => {
    expect(formatOriginDefaultRelationLabel(included)).toBe("Included in origin/main");
    expect(formatOriginDefaultRelationLabel(exact)).toBe("Included in origin/main");
  });

  it("keeps patch-equivalent visibly distinct and still protected", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 2,
        originDefaultRelation: patchEquivalent,
        diffStat: null,
      }),
    ).toEqual(["Patch-equivalent to origin/main (not ancestral; still protected)"]);
    expect(formatOriginDefaultRelationLabel(patchEquivalent)).toBe(
      "Patch-equivalent to origin/main (not ancestral; still protected)",
    );
    expect(classifyOriginDefaultArchivePushRisk(patchEquivalent)).toBe("patch_equivalent");
  });

  it("keeps ahead/diverged/unverifiable as unpushed risk when aheadOfOrigin is positive", () => {
    for (const relation of [ahead, diverged, unverifiable]) {
      expect(
        buildWorktreeArchiveRiskReasons({
          isDirty: false,
          aheadOfOrigin: 2,
          originDefaultRelation: relation,
          diffStat: null,
        }),
      ).toEqual(["2 unpushed commits"]);
    }
  });

  it("falls back to legacy unpushed labeling when originDefaultRelation is missing", () => {
    expect(
      buildWorktreeArchiveRiskReasons({
        isDirty: false,
        aheadOfOrigin: 4,
        originDefaultRelation: null,
        diffStat: null,
      }),
    ).toEqual(["4 unpushed commits"]);
    expect(formatOriginDefaultRelationLabel(null, undefined, 4)).toBe("4 unpushed commits");
    expect(classifyOriginDefaultArchivePushRisk(undefined)).toBe("unknown");
  });
});
