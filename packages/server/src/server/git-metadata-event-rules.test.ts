import { describe, expect, test } from "vitest";
import {
  classifyGitMetadataPath,
  GIT_METADATA_EVENT_RULES,
  getPrunedGitMetadataPaths,
} from "./git-metadata-event-rules.js";

describe("Git metadata event rules", () => {
  test("has unique rule names", () => {
    const names = GIT_METADATA_EVENT_RULES.map((rule) => rule.id);
    expect(new Set(names).size).toBe(names.length);
  });

  test("derives watcher pruning from the same inventory", () => {
    expect(getPrunedGitMetadataPaths("common")).toEqual(["hooks", "logs", "objects"]);
    expect(getPrunedGitMetadataPaths("worktree")).toEqual([]);
  });

  test.each([
    ["worktree", "index", { kind: "owner", refreshBase: false }],
    ["worktree", "HEAD", { kind: "owner", refreshBase: true }],
    ["worktree", "config.worktree", { kind: "owner", refreshBase: true }],
    ["worktree", "paseo/worktree.json", { kind: "owner", refreshBase: true }],
    ["worktree", "COMMIT_EDITMSG", { kind: "ignore" }],
    ["worktree", "ORIG_HEAD", { kind: "ignore" }],
    ["common", "index", { kind: "owner", refreshBase: false }],
    ["common", "HEAD", { kind: "owner", refreshBase: true }],
    ["common", "refs/heads/feature", { kind: "ref", namespace: "local", ref: "feature" }],
    [
      "common",
      "refs/remotes/origin/main",
      { kind: "ref", namespace: "remote", ref: "origin/main" },
    ],
    ["common", "packed-refs", { kind: "all", refreshBase: true }],
    ["common", "reftable/tables.list", { kind: "all", refreshBase: true }],
    ["common", "config", { kind: "all", refreshBase: true }],
    ["common", "worktrees/new/index", { kind: "ignore" }],
    ["common", "hooks/pre-commit", { kind: "ignore" }],
    ["common", "logs/refs/heads/main", { kind: "ignore" }],
    ["common", "objects/ab/cdef", { kind: "ignore" }],
    ["common", "modules/sdk/index", { kind: "all", refreshBase: false }],
    ["common", "modules/sdk/HEAD", { kind: "all", refreshBase: true }],
    ["common", "modules/sdk/refs/heads/main", { kind: "all", refreshBase: true }],
    ["common", "modules/nested/sdk/packed-refs", { kind: "all", refreshBase: true }],
    ["common", "modules/sdk/reftable/tables.list", { kind: "all", refreshBase: true }],
    ["common", "modules/sdk/objects/ab/cdef", { kind: "ignore" }],
    ["common", "modules/sdk/logs/HEAD", { kind: "ignore" }],
    ["common", "modules/sdk/refs/heads/main.lock", { kind: "ignore" }],
    ["common", "refs/tags/v1", { kind: "ignore" }],
    ["common", "FETCH_HEAD", { kind: "ignore" }],
    ["common", "packed-refs.lock", { kind: "ignore" }],
  ] as const)("classifies %s metadata path %s", (scope, path, expected) => {
    expect(classifyGitMetadataPath(scope, path)).toEqual(expected);
  });
});
