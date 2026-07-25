import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("working diff tab identity", () => {
  const target = {
    kind: "working_diff" as const,
    focusPath: "src/example.ts",
    focusRequestId: 1,
  };

  it("normalizes file focus navigation", () => {
    expect(
      normalizeWorkspaceTabTarget({
        ...target,
        focusPath: " src\\example.ts ",
      }),
    ).toEqual(target);
  });

  it("treats focus as navigation state rather than tab identity", () => {
    expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, focusPath: "src/other.ts" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, focusRequestId: 2 })).toBe(false);
    const workingDiffId = buildDeterministicWorkspaceTabId(target);
    const otherFocusId = buildDeterministicWorkspaceTabId({
      ...target,
      focusPath: "src/other.ts",
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: target.focusPath,
    });

    expect(workingDiffId).toBe("working_diff");
    expect(workingDiffId).toBe(otherFocusId);
    expect(workingDiffId).not.toBe(fileId);
  });
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});
