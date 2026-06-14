import { describe, expect, it } from "vitest";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import {
  NEW_BRANCH_OPTION_ID,
  computePickerOptionData,
  pickerItemLabel,
  pickerItemOptionId,
} from "./new-workspace-picker-options";

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
  updatedAt: "2026-06-14T00:00:00Z",
};

describe("computePickerOptionData", () => {
  it("keeps the new branch action at the top before sorted refs", () => {
    const data = computePickerOptionData({
      branchDetails: [
        { name: "main", committerDate: 1 },
        { name: "feature/recent", committerDate: 10 },
      ],
      prItems: [prItem],
      newBranchLabel: "New branch",
    });

    expect(data.options[0]).toEqual({
      id: NEW_BRANCH_OPTION_ID,
      label: "New branch",
    });
    expect(data.itemById.get(NEW_BRANCH_OPTION_ID)).toEqual({
      kind: "new-branch",
    });
    expect(data.options.slice(1).map((option) => option.id)).toEqual([
      "github-pr:42",
      "branch:feature/recent",
      "branch:main",
    ]);
  });
});

describe("pickerItemLabel", () => {
  it("uses the localized new branch label for the new branch row", () => {
    expect(pickerItemLabel({ kind: "new-branch" }, { newBranch: "새 브랜치" })).toBe("새 브랜치");
  });
});

describe("pickerItemOptionId", () => {
  it("returns the stable new branch option id", () => {
    expect(pickerItemOptionId({ kind: "new-branch" })).toBe(NEW_BRANCH_OPTION_ID);
  });
});
