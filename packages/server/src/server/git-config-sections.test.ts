import { describe, expect, test } from "vitest";
import { changedBranchSections, parseGitConfigSections } from "./git-config-sections.js";

const BASE = `[core]
\trepositoryformatversion = 0
\tbare = false
[remote "origin"]
\turl = git@github.com:acme/app.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;

function change(before: string, after: string): Set<string> | null {
  return changedBranchSections(parseGitConfigSections(before), parseGitConfigSections(after));
}

describe("changedBranchSections", () => {
  test("names the branch a `git push -u` adds tracking for", () => {
    const after = `${BASE}[branch "feat/x"]\n\tremote = origin\n\tmerge = refs/heads/feat/x\n`;
    expect(change(BASE, after)).toEqual(new Set(["feat/x"]));
  });

  test("names the branch whose section a `git branch -d` removes", () => {
    const before = `${BASE}[branch "old"]\n\tremote = origin\n`;
    expect(change(before, BASE)).toEqual(new Set(["old"]));
  });

  test("an identical rewrite changes nothing", () => {
    expect(change(BASE, BASE)).toEqual(new Set());
  });

  test("a change outside branch sections is a change to everything", () => {
    expect(change(BASE, BASE.replace("bare = false", "bare = false\n\texcludesFile = ~/.ignore"))).toBeNull();
    expect(change(BASE, `${BASE}[remote "fork"]\n\turl = x\n`)).toBeNull();
    expect(change(BASE, `${BASE}[branch]\n\tautoSetupMerge = false\n`)).toBeNull();
    expect(change(BASE, `${BASE}[branch.legacy]\n\tremote = origin\n`)).toBeNull();
  });

  test("a repeated section header and an escaped quote parse as one branch", () => {
    const after = `${BASE}[branch "a\\"b"]\n\tremote = origin\n[branch "a\\"b"]\n\tmerge = refs/heads/a\n`;
    expect(change(BASE, after)).toEqual(new Set(['a"b']));
  });
});
