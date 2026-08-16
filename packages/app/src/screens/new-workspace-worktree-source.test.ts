import { describe, expect, it } from "vitest";
import {
  buildWorktreeCheckoutRequest,
  worktreeSlugForPickerItem,
  type WorktreeSourceMode,
} from "./new-workspace-worktree-source";
import type { PickerItem } from "./new-workspace-picker-item";

function branch(refName: string, name = "feature/login"): PickerItem {
  return {
    kind: "branch",
    name,
    refName,
    accessibilityLabel: `${name}, branch`,
  };
}

describe("new workspace worktree source", () => {
  it.each<WorktreeSourceMode>(["new-branch", "existing-branch"])(
    "requires a selected branch for %s mode",
    (mode) => {
      expect(() => buildWorktreeCheckoutRequest({ mode, item: null })).toThrow("Choose a branch");
    },
  );

  it("creates a new branch from the selected branch", () => {
    expect(
      buildWorktreeCheckoutRequest({
        mode: "new-branch",
        item: branch("refs/remotes/origin/main", "main"),
      }),
    ).toEqual({
      action: "branch-off",
      refName: "refs/remotes/origin/main",
    });
  });

  it("checks out the selected existing branch and names the worktree after it", () => {
    const item = branch("refs/heads/feature/login");
    expect(buildWorktreeCheckoutRequest({ mode: "existing-branch", item })).toEqual({
      action: "checkout",
      refName: "refs/heads/feature/login",
      worktreeSlug: "feature-login",
    });
  });

  it("does not include display-only local or remote qualifiers in the worktree name", () => {
    expect(
      worktreeSlugForPickerItem(
        branch("refs/remotes/origin/feature/login", "feature/login (origin)"),
      ),
    ).toBe("feature-login");
  });
});
