import { describe, expect, it } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import {
  type BranchPickerDetail,
  branchPickerOptionId,
  buildBranchPickerItems,
  buildPickerOptionData,
  defaultBasePickerItem,
  pickerItemToCheckoutRequest,
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
  it("keeps a single origin row when local and origin match", () => {
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
        refName: "refs/remotes/origin/main",
        accessibilityLabel: "main, origin branch",
        committerDate: 10,
      },
    ]);
  });

  it("puts the origin row first and disambiguates the local row when the refs differ", () => {
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
        refName: "refs/remotes/origin/main",
        accessibilityLabel: "main, origin branch",
        committerDate: 10,
      },
      {
        kind: "branch",
        name: "main (local)",
        refName: "refs/heads/main",
        divergenceLabel: "+3 −2",
        accessibilityLabel: "main, local branch, 3 commits ahead and 2 behind origin main",
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
        name: "release",
        refName: "refs/remotes/origin/release",
        accessibilityLabel: "release, origin branch",
        committerDate: 5,
      },
    ]);
  });

  it("keeps the plain name for a local-only branch", () => {
    expect(
      buildBranchPickerItems([
        {
          name: "scratch",
          committerDate: 5,
          hasLocal: true,
          hasRemote: false,
        },
      ]),
    ).toEqual([
      {
        kind: "branch",
        name: "scratch",
        refName: "refs/heads/scratch",
        accessibilityLabel: "scratch, local branch",
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
        refName: "refs/remotes/origin/main",
        accessibilityLabel: "main, origin branch",
        committerDate: 10,
      },
      {
        kind: "branch",
        name: "main (local)",
        refName: "refs/heads/main",
        accessibilityLabel: "main, local branch",
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

const mainRow: BranchPickerDetail = {
  name: "main",
  committerDate: 10,
  hasLocal: true,
  hasRemote: true,
  localAhead: 2,
  localBehind: 0,
};

describe("buildPickerOptionData", () => {
  it("marks origin and keeps an ahead local main explicit", () => {
    const baseItem = defaultBasePickerItem({
      currentBranch: "main",
      upstreamRef: "refs/remotes/origin/main",
    });
    const data = buildPickerOptionData({ branchDetails: [mainRow], prItems: [], baseItem });

    expect(data.options.map((option) => option.label)).toEqual(["main", "main (local)"]);
    expect(data.selectedOptionId).toBe(branchPickerOptionId("refs/remotes/origin/main"));
  });

  it("adds and disambiguates a fork upstream absent from branch suggestions", () => {
    const baseItem = defaultBasePickerItem({
      currentBranch: "main",
      upstreamRef: "refs/remotes/upstream/main",
    });
    const data = buildPickerOptionData({
      branchDetails: [{ ...mainRow, localAhead: 0, localBehind: 0 }],
      prItems: [],
      baseItem,
    });

    expect(data.options.map((option) => option.label)).toEqual(["main (upstream)", "main"]);
    expect(data.selectedOptionId).toBe(branchPickerOptionId("refs/remotes/upstream/main"));
  });

  it("marks a visible row on an old daemon when local and origin are in sync", () => {
    const baseItem = defaultBasePickerItem({ currentBranch: "main" });
    const data = buildPickerOptionData({
      branchDetails: [{ ...mainRow, localAhead: 0, localBehind: 0 }],
      prItems: [],
      baseItem,
    });

    expect(data.options.map((option) => option.label)).toEqual(["main (local)", "main"]);
    expect(data.selectedOptionId).toBe(branchPickerOptionId("refs/heads/main"));
  });

  it("keeps an explicit local selection marked", () => {
    const baseItem: PickerItem = {
      kind: "branch",
      name: "main (local)",
      refName: "refs/heads/main",
      accessibilityLabel: "main, local branch",
    };
    const data = buildPickerOptionData({
      branchDetails: [mainRow],
      prItems: [],
      baseItem,
    });
    const selected = data.itemById.get(data.selectedOptionId) ?? null;
    expect(pickerItemToCheckoutRequest(selected)).toEqual({
      action: "branch-off",
      refName: "refs/heads/main",
    });
  });
});

describe("defaultBasePickerItem", () => {
  it("uses origin when the current branch tracks origin", () => {
    expect(
      defaultBasePickerItem({
        currentBranch: "main",
        upstreamRef: "refs/remotes/origin/main",
      }),
    ).toMatchObject({ refName: "refs/remotes/origin/main", name: "main" });
  });

  it("uses the exact non-origin upstream", () => {
    expect(
      defaultBasePickerItem({
        currentBranch: "main",
        upstreamRef: "refs/remotes/upstream/main",
      }),
    ).toMatchObject({ refName: "refs/remotes/upstream/main", name: "main" });
  });

  it("keeps old-daemon behavior local", () => {
    expect(defaultBasePickerItem({ currentBranch: "main" })).toMatchObject({
      refName: "refs/heads/main",
      name: "main",
    });
  });

  it("has no default for detached HEAD", () => {
    expect(defaultBasePickerItem({ currentBranch: null })).toBeNull();
  });
});
