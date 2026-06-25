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

describe("buildDeterministicWorkspaceTabId for diff tabs", () => {
  it("keys a working diff tab by its diff target, not focusPath", () => {
    const withoutFocus = buildDeterministicWorkspaceTabId({
      kind: "diff",
      diffTarget: { kind: "working", mode: "uncommitted" },
    });
    const withFocus = buildDeterministicWorkspaceTabId({
      kind: "diff",
      diffTarget: { kind: "working", mode: "uncommitted" },
      focusPath: "src/index.ts",
    });
    expect(withoutFocus).toBe("diff_working:uncommitted:");
    expect(withFocus).toBe(withoutFocus);
  });

  it("keys a commit diff tab by its sha", () => {
    expect(
      buildDeterministicWorkspaceTabId({
        kind: "diff",
        diffTarget: { kind: "commit", sha: "abc123" },
      }),
    ).toBe("diff_commit:abc123");
  });

  it("gives the working diff tab and a commit diff tab distinct ids", () => {
    const working = buildDeterministicWorkspaceTabId({
      kind: "diff",
      diffTarget: { kind: "working", mode: "uncommitted" },
    });
    const commit = buildDeterministicWorkspaceTabId({
      kind: "diff",
      diffTarget: { kind: "commit", sha: "abc123" },
    });
    expect(working).not.toBe(commit);
  });

  it("does not collide a diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({
      kind: "diff",
      diffTarget: { kind: "commit", sha: "abc123" },
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "commit:abc123",
    });
    expect(diffId).not.toBe(fileId);
  });
});

describe("workspaceTabTargetsEqual for diff tabs", () => {
  it("treats two working diff targets that differ only in focusPath as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "diff", diffTarget: { kind: "working", mode: "uncommitted" } },
        {
          kind: "diff",
          diffTarget: { kind: "working", mode: "uncommitted" },
          focusPath: "src/index.ts",
        },
      ),
    ).toBe(true);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "diff", diffTarget: { kind: "commit", sha: "abc123" } },
        { kind: "diff", diffTarget: { kind: "commit", sha: "abc123" }, focusPath: "a.ts" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "diff", diffTarget: { kind: "commit", sha: "abc123" } },
        { kind: "diff", diffTarget: { kind: "commit", sha: "def456" } },
      ),
    ).toBe(false);
  });

  it("treats a working diff target and a commit diff target as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "diff", diffTarget: { kind: "working", mode: "uncommitted" } },
        { kind: "diff", diffTarget: { kind: "commit", sha: "abc123" } },
      ),
    ).toBe(false);
  });
});

describe("normalizeWorkspaceTabTarget for diff tabs", () => {
  it("passes a working diff target through and drops a blank focusPath", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "diff",
        diffTarget: { kind: "working", mode: "uncommitted" },
        focusPath: "   ",
      }),
    ).toEqual({ kind: "diff", diffTarget: { kind: "working", mode: "uncommitted" } });
  });

  it("normalizes a working base diff target and keeps focusPath", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "diff",
        diffTarget: { kind: "working", mode: "base", baseRef: "main", ignoreWhitespace: true },
        focusPath: "src/index.ts",
      }),
    ).toEqual({
      kind: "diff",
      diffTarget: { kind: "working", mode: "base", baseRef: "main", ignoreWhitespace: true },
      focusPath: "src/index.ts",
    });
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "diff",
        diffTarget: { kind: "commit", sha: "abc123" },
      }),
    ).toEqual({ kind: "diff", diffTarget: { kind: "commit", sha: "abc123" } });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "diff",
        diffTarget: { kind: "commit", sha: "   " },
      }),
    ).toBeNull();
  });
});
