import { describe, expect, it } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { CheckoutStatusPayload } from "@/git/checkout-status-cache";
import {
  branchPickerOptionId,
  buildBranchPickerItems,
  pickerItemToCheckoutRequest,
  resolveCheckoutRequest,
  type PickerItem,
} from "./new-workspace-picker-item";

const prItem: ForgeSearchItem = {
  kind: "change_request",
  number: 42,
  title: "Add picker",
  url: "https://example.com/pull/42",
  state: "open",
  body: null,
  labels: [],
  baseRefName: "main",
  headRefName: "feature/picker",
};

describe("branchPickerOptionId", () => {
  it("distinguishes a local origin-prefixed branch from the origin ref", () => {
    expect(branchPickerOptionId("refs/heads/origin/main")).not.toBe(
      branchPickerOptionId("refs/remotes/origin/main"),
    );
  });
});

describe("pickerItemToCheckoutRequest", () => {
  it("returns undefined for no selection (null)", () => {
    expect(pickerItemToCheckoutRequest(null)).toBeUndefined();
  });

  it("maps a branch row to branch-off with its exact ref", () => {
    const item: PickerItem = {
      kind: "branch",
      name: "dev",
      refName: "refs/heads/dev",
      accessibilityLabel: "dev, local branch",
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "branch-off",
      refName: "refs/heads/dev",
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
      checkoutSource: { kind: "change_request", forge: "github", number: 42 },
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
      checkoutSource: { kind: "change_request", forge: "github", number: 7 },
      githubPrNumber: 7,
    });
  });

  it("does not send the legacy githubPrNumber for non-GitHub change requests", () => {
    const item: PickerItem = {
      kind: "github-pr",
      item: {
        ...prItem,
        forge: "gitlab",
        number: 21,
        projectPath: "acme/repo",
        url: "https://gitlab.example.com/acme/repo/-/merge_requests/21",
      },
    };
    expect(pickerItemToCheckoutRequest(item)).toEqual({
      action: "checkout",
      refName: "feature/picker",
      checkoutSource: {
        kind: "change_request",
        forge: "gitlab",
        number: 21,
        projectPath: "acme/repo",
      },
    });
  });
});

describe("buildBranchPickerItems", () => {
  it("hides the origin duplicate when local and origin match", () => {
    expect(
      buildBranchPickerItems([
        {
          name: "main",
          committerDate: 10,
          hasLocal: true,
          hasRemote: true,
          localAhead: 0,
          localBehind: 0,
        },
      ]),
    ).toEqual([
      {
        kind: "branch",
        name: "main",
        refName: "refs/heads/main",
        accessibilityLabel: "main, local branch, up to date with origin main",
        committerDate: 10,
      },
    ]);
  });

  it("creates compact local and origin rows when the refs differ", () => {
    expect(
      buildBranchPickerItems([
        {
          name: "main",
          committerDate: 10,
          hasLocal: true,
          hasRemote: true,
          localAhead: 3,
          localBehind: 2,
        },
      ]),
    ).toEqual([
      {
        kind: "branch",
        name: "main",
        refName: "refs/heads/main",
        divergenceLabel: "+3 −2",
        accessibilityLabel: "main, local branch, 3 commits ahead and 2 behind origin main",
        committerDate: 10,
      },
      {
        kind: "branch",
        name: "origin/main",
        refName: "refs/remotes/origin/main",
        divergenceLabel: "+2 −3",
        accessibilityLabel: "origin main, 2 commits ahead and 3 behind local main",
        committerDate: 10,
      },
    ]);
  });

  it("uses an exact origin ref for remote-only branches", () => {
    expect(
      buildBranchPickerItems([
        {
          name: "release",
          committerDate: 5,
          hasLocal: false,
          hasRemote: true,
        },
      ]),
    ).toEqual([
      {
        kind: "branch",
        name: "origin/release",
        refName: "refs/remotes/origin/release",
        accessibilityLabel: "origin release, origin branch",
        committerDate: 5,
      },
    ]);
  });

  it("shows both refs when their divergence is unavailable", () => {
    expect(
      buildBranchPickerItems([
        {
          name: "main",
          committerDate: 10,
          hasLocal: true,
          hasRemote: true,
        },
      ]),
    ).toEqual([
      {
        kind: "branch",
        name: "main",
        refName: "refs/heads/main",
        accessibilityLabel: "main, local branch",
        committerDate: 10,
      },
      {
        kind: "branch",
        name: "origin/main",
        refName: "refs/remotes/origin/main",
        accessibilityLabel: "origin main, origin branch",
        committerDate: 10,
      },
    ]);
  });

  it("keeps the legacy unqualified row when provenance is unavailable", () => {
    expect(buildBranchPickerItems([{ name: "legacy", committerDate: 1 }])).toEqual([
      {
        kind: "branch",
        name: "legacy",
        refName: "legacy",
        accessibilityLabel: "legacy, branch",
        committerDate: 1,
      },
    ]);
  });
});

describe("resolveCheckoutRequest", () => {
  const checkoutStatus = {
    currentBranch: "feature/current",
  } as CheckoutStatusPayload;

  it("branches from the loaded current branch when nothing was picked", () => {
    expect(resolveCheckoutRequest(null, checkoutStatus)).toEqual({
      action: "branch-off",
      refName: "feature/current",
    });
  });

  it("prefers an explicit picker selection", () => {
    expect(
      resolveCheckoutRequest(
        {
          kind: "branch",
          name: "feature/picked",
          refName: "refs/heads/feature/picked",
          accessibilityLabel: "feature/picked, local branch",
        },
        checkoutStatus,
      ),
    ).toEqual({
      action: "branch-off",
      refName: "refs/heads/feature/picked",
    });
  });

  it("preserves the server-default intent for a detached checkout", () => {
    expect(
      resolveCheckoutRequest(null, { ...checkoutStatus, currentBranch: null }),
    ).toBeUndefined();
  });
});
