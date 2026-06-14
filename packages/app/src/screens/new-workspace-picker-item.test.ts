import { describe, expect, it } from "vitest";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import {
  pickerItemToCheckoutRequest,
  resolveNewWorkspaceCheckoutRequest,
  type PickerItem,
} from "./new-workspace-picker-item";

const prItem: GitHubSearchItem = {
  kind: "pr",
  number: 42,
  title: "Add picker",
  url: "https://example.com/pull/42",
  state: "open",
  body: null,
  labels: [],
  baseRefName: "main",
  headRefName: "feature/picker",
};

describe("pickerItemToCheckoutRequest", () => {
  it("returns undefined for no selection (null)", () => {
    expect(pickerItemToCheckoutRequest(null)).toBeUndefined();
  });

  it("returns undefined for the new branch row", () => {
    expect(pickerItemToCheckoutRequest({ kind: "new-branch" })).toBeUndefined();
  });

  it("maps a branch row to branch-off with the branch name", () => {
    const item: PickerItem = { kind: "branch", name: "dev" };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "branch-off",
      refName: "dev",
    });
  });

  it("maps a github-pr row to checkout using the head ref and pr number", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: prItem,
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "feature/picker",
      githubPrNumber: 42,
    });
  });

  it("handles a github-pr with a null baseRef", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: {
        ...prItem,
        number: 7,
        title: "Orphan branch",
        baseRefName: null,
        headRefName: "orphan",
      },
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "orphan",
      githubPrNumber: 7,
    });
  });
});

describe("resolveNewWorkspaceCheckoutRequest", () => {
  it("branches off the current branch when no picker item is selected", () => {
    expect(
      resolveNewWorkspaceCheckoutRequest({
        selectedItem: null,
        currentBranch: "main",
      }),
    ).toEqual({
      checkoutRequest: {
        action: "branch-off",
        refName: "main",
      },
    });
  });

  it("uses a new branch slug as the requested worktree and branch name", () => {
    expect(
      resolveNewWorkspaceCheckoutRequest({
        selectedItem: { kind: "branch", name: "develop" },
        currentBranch: "main",
        newBranchSlug: "feature-korea",
      }),
    ).toEqual({
      worktreeSlug: "feature-korea",
      checkoutRequest: {
        action: "branch-off",
        refName: "develop",
      },
    });
  });

  it("does not check out a PR when a new branch slug is provided", () => {
    expect(
      resolveNewWorkspaceCheckoutRequest({
        selectedItem: { kind: "github-pr", item: prItem },
        currentBranch: "main",
        newBranchSlug: "from-main",
      }),
    ).toEqual({
      worktreeSlug: "from-main",
      checkoutRequest: {
        action: "branch-off",
        refName: "main",
      },
    });
  });

  it("uses the current branch when creating a new branch from the new branch row", () => {
    expect(
      resolveNewWorkspaceCheckoutRequest({
        selectedItem: { kind: "new-branch" },
        currentBranch: "main",
        newBranchSlug: "feature-korea",
      }),
    ).toEqual({
      worktreeSlug: "feature-korea",
      checkoutRequest: {
        action: "branch-off",
        refName: "main",
      },
    });
  });
});
