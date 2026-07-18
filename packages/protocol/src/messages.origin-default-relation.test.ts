import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CheckoutStatusResponseSchema,
  CheckoutStatusUpdateSchema,
  OriginDefaultRelationSchema,
  WorkspaceDescriptorPayloadSchema,
} from "./messages.js";

const originDefaultRelation = {
  state: "included" as const,
  resolvedRef: "origin/main",
  ahead: 0,
  behind: 2,
  uniquePatchCount: 0,
};

describe("originDefaultRelation protocol additive compatibility", () => {
  test("OriginDefaultRelationSchema accepts every documented state", () => {
    for (const state of [
      "exact",
      "included",
      "ahead",
      "patch_equivalent_not_included",
      "diverged_with_unique_commits",
      "unverifiable",
    ] as const) {
      expect(
        OriginDefaultRelationSchema.parse({
          state,
          resolvedRef: state === "unverifiable" ? null : "origin/main",
          ahead: state === "unverifiable" ? null : 0,
          behind: state === "unverifiable" ? null : 0,
          uniquePatchCount: state === "unverifiable" ? null : 0,
        }).state,
      ).toBe(state);
    }
  });

  test("checkout_status_response accepts additive originDefaultRelation and keeps legacy fields", () => {
    const parsed = CheckoutStatusResponseSchema.parse({
      type: "checkout_status_response",
      payload: {
        cwd: "/tmp/repo",
        isGit: true,
        isPaseoOwnedWorktree: false,
        repoRoot: "/tmp/repo",
        mainRepoRoot: null,
        currentBranch: "feature",
        isDirty: false,
        baseRef: "main",
        aheadBehind: { ahead: 1, behind: 0 },
        aheadOfOrigin: 1,
        behindOfOrigin: 0,
        originDefaultRelation,
        hasRemote: true,
        remoteUrl: "https://github.com/acme/repo.git",
        error: null,
        requestId: "req-1",
      },
    });

    expect(parsed.payload).toMatchObject({
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
      originDefaultRelation,
    });
  });

  test("checkout_status_response without originDefaultRelation still parses (old daemon)", () => {
    const parsed = CheckoutStatusResponseSchema.parse({
      type: "checkout_status_response",
      payload: {
        cwd: "/tmp/repo",
        isGit: true,
        isPaseoOwnedWorktree: false,
        repoRoot: "/tmp/repo",
        currentBranch: "feature",
        isDirty: false,
        baseRef: "main",
        aheadBehind: { ahead: 1, behind: 0 },
        aheadOfOrigin: 1,
        behindOfOrigin: 0,
        hasRemote: true,
        remoteUrl: "https://github.com/acme/repo.git",
        error: null,
        requestId: "req-old",
      },
    });

    expect(parsed.payload.isGit).toBe(true);
    if (parsed.payload.isGit) {
      expect(parsed.payload.originDefaultRelation).toBeUndefined();
      expect(parsed.payload.aheadOfOrigin).toBe(1);
    }
  });

  test("checkout_status_update propagates originDefaultRelation", () => {
    const parsed = CheckoutStatusUpdateSchema.parse({
      type: "checkout_status_update",
      payload: {
        cwd: "/tmp/repo",
        isGit: true,
        isPaseoOwnedWorktree: true,
        repoRoot: "/tmp/wt",
        mainRepoRoot: "/tmp/repo",
        currentBranch: "feature",
        isDirty: false,
        baseRef: "main",
        aheadBehind: { ahead: 0, behind: 0 },
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
        originDefaultRelation: {
          state: "exact",
          resolvedRef: "origin/main",
          ahead: 0,
          behind: 0,
          uniquePatchCount: 0,
        },
        hasRemote: true,
        remoteUrl: "https://github.com/acme/repo.git",
        error: null,
        requestId: "subscription:/tmp/wt",
      },
    });

    expect(parsed.payload).toMatchObject({
      originDefaultRelation: {
        state: "exact",
        resolvedRef: "origin/main",
      },
    });
  });

  test("workspace gitRuntime accepts additive originDefaultRelation", () => {
    const parsed = WorkspaceDescriptorPayloadSchema.parse({
      id: "ws-1",
      projectId: "remote:github.com/acme/repo",
      projectDisplayName: "acme/repo",
      projectRootPath: "/tmp/repo",
      workspaceDirectory: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature",
      status: "done",
      activityAt: null,
      diffStat: null,
      gitRuntime: {
        currentBranch: "feature",
        remoteUrl: "https://github.com/acme/repo.git",
        isPaseoOwnedWorktree: true,
        isDirty: false,
        aheadBehind: { ahead: 0, behind: 1 },
        aheadOfOrigin: 2,
        behindOfOrigin: 0,
        originDefaultRelation,
      },
    });

    expect(parsed.gitRuntime).toMatchObject({
      aheadOfOrigin: 2,
      originDefaultRelation,
    });
  });

  test("older workspace parsers ignore additive originDefaultRelation", () => {
    const legacyGitRuntimeSchema = z.object({
      currentBranch: z.string().nullable().optional(),
      aheadOfOrigin: z.number().nullable().optional(),
      behindOfOrigin: z.number().nullable().optional(),
    });

    const message = {
      gitRuntime: {
        currentBranch: "feature",
        aheadOfOrigin: 2,
        behindOfOrigin: 0,
        originDefaultRelation,
      },
    };

    const parsed = legacyGitRuntimeSchema.parse(message.gitRuntime);
    expect(parsed).toEqual({
      currentBranch: "feature",
      aheadOfOrigin: 2,
      behindOfOrigin: 0,
    });
    // Additive field is stripped by the old parser shape.
    expect("originDefaultRelation" in parsed).toBe(false);
  });
});
