import { describe, expect, it } from "vitest";
import type { RepositoryGraphCommit } from "@getpaseo/protocol/messages";
import { layoutRepositoryGraph } from "./layout";

function commit(sha: string, parents: string[], current = false): RepositoryGraphCommit {
  return {
    sha,
    shortSha: sha,
    parents,
    subject: sha,
    authorName: "Test User",
    authorDate: "2026-01-01T00:00:00Z",
    refs: current ? [{ name: "main", kind: "head", current: true }] : [],
  };
}

describe("layoutRepositoryGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutRepositoryGraph([
      commit("c", ["b"], true),
      commit("b", ["a"]),
      commit("a", []),
    ]);

    expect(rows.map((row) => row.column)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.laneCount)).toEqual([1, 1, 1]);
    expect(rows.map((row) => row.color)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.startsLane)).toEqual([true, false, false]);
  });

  it("creates and rejoins lanes for a merge", () => {
    const rows = layoutRepositoryGraph([
      commit("merge", ["main", "feature"], true),
      commit("feature", ["base"]),
      commit("main", ["base"]),
      commit("base", []),
    ]);

    expect(rows[0]?.edges.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 1 },
    ]);
    expect(rows[1]?.column).toBe(1);
    expect(rows[2]?.column).toBe(0);
    expect(rows[3]?.column).toBe(0);
    expect(rows.map((row) => row.color)).toEqual([0, 1, 0, 0]);
    expect(rows[0]?.edges.map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ]);
    expect(rows[2]?.edges.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
  });

  it("keeps each active branch on one color through multiple commits", () => {
    const rows = layoutRepositoryGraph([
      commit("merge", ["main-2", "feature-2"], true),
      commit("feature-2", ["feature-1"]),
      commit("feature-1", ["base"]),
      commit("main-2", ["main-1"]),
      commit("main-1", ["base"]),
      commit("base", []),
    ]);

    expect(rows.map((row) => row.color)).toEqual([0, 1, 1, 0, 0, 0]);
  });

  it("keeps nested merges in stable lanes until their shared ancestors", () => {
    const rows = layoutRepositoryGraph([
      commit("merge-release", ["main-2", "release"], true),
      commit("release", ["merge-feature"]),
      commit("merge-feature", ["main-1", "feature"]),
      commit("feature", ["base"]),
      commit("main-2", ["main-1"]),
      commit("main-1", ["base"]),
      commit("base", []),
    ]);

    expect(rows.map((row) => row.column)).toEqual([0, 1, 1, 2, 0, 0, 0]);
    expect(rows.map((row) => row.color)).toEqual([0, 1, 1, 2, 0, 0, 0]);
    expect(rows.map((row) => row.laneCount)).toEqual([2, 2, 3, 3, 3, 2, 1]);
    expect(rows[5]?.edges.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
  });

  it("restores the existing trunk color when a side lane rejoins it", () => {
    const rows = layoutRepositoryGraph([
      commit("merge", ["trunk", "branch-2"], true),
      commit("branch-2", ["branch-1"]),
      commit("branch-1", ["base"]),
      commit("trunk", ["base"]),
      commit("base", ["older"]),
      commit("older", []),
    ]);

    expect(rows[2]?.column).toBe(1);
    expect(rows[2]?.color).toBe(1);
    expect(rows[4]?.column).toBe(0);
    expect(rows[4]?.color).toBe(0);
  });

  it("keeps independent worktree tips in separate right-side lanes", () => {
    const rows = layoutRepositoryGraph([
      commit("worktree-a", ["shared"]),
      commit("worktree-b", ["shared"]),
      commit("main", ["shared"], true),
      commit("shared", ["base"]),
      commit("base", []),
    ]);

    expect(rows.slice(0, 3).map((row) => row.column)).toEqual([0, 1, 2]);
    expect(rows.slice(0, 3).map((row) => row.color)).toEqual([0, 1, 2]);
    expect(rows.slice(0, 3).map((row) => row.startsLane)).toEqual([true, true, true]);
    expect(rows[3]?.column).toBe(0);
    expect(rows[3]?.laneCount).toBe(1);
    expect(rows[3]?.startsLane).toBe(false);
  });

  it("keeps an existing parent branch color when another branch joins it", () => {
    const rows = layoutRepositoryGraph([
      commit("side-tip", ["side-base"]),
      commit("merge", ["main", "side-base"], true),
      commit("main", ["side-base"]),
      commit("side-base", ["base"]),
      commit("base", []),
    ]);

    expect(rows.map((row) => row.color)).toEqual([0, 1, 1, 0, 0]);
    expect(rows[1]?.edges.at(-1)?.color).toBe(1);
    expect(rows[3]?.color).toBe(0);
  });

  it("reuses a color only after its previous branch is no longer visible", () => {
    const rows = layoutRepositoryGraph([
      commit("first-tip", ["first-root"]),
      commit("first-root", []),
      commit("second-tip", ["second-root"]),
      commit("second-root", []),
    ]);

    expect(rows.map((row) => row.color)).toEqual([0, 0, 0, 0]);
    expect(rows.map((row) => row.column)).toEqual([0, 0, 0, 0]);
    expect(rows.map((row) => row.startsLane)).toEqual([true, false, true, false]);
  });
});
