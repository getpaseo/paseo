import { describe, expect, it } from "vitest";
import {
  createNewBranchPlaceholderName,
  resolveNewBranchError,
  resolveRequestedNewBranchSlug,
} from "./new-workspace-branch-name";

describe("createNewBranchPlaceholderName", () => {
  it("creates a slug-style three word placeholder", () => {
    expect(
      createNewBranchPlaceholderName({
        createName: () => "Quiet Bright Otter",
      }),
    ).toBe("quiet-bright-otter");
  });

  it("avoids reusing the previous placeholder", () => {
    const names = ["quiet-bright-otter", "quiet-bright-otter", "steady-silver-fox"];

    expect(
      createNewBranchPlaceholderName({
        previousName: "quiet-bright-otter",
        createName: () => names.shift() ?? "steady-silver-fox",
      }),
    ).toBe("steady-silver-fox");
  });
});

describe("resolveRequestedNewBranchSlug", () => {
  it("uses the placeholder when the new branch row is selected and the field is empty", () => {
    expect(
      resolveRequestedNewBranchSlug({
        selectedItem: { kind: "new-branch" },
        newBranchName: "   ",
        placeholderName: "steady-silver-fox",
      }),
    ).toBe("steady-silver-fox");
  });

  it("does not use the placeholder for another selected ref", () => {
    expect(
      resolveRequestedNewBranchSlug({
        selectedItem: { kind: "branch", name: "main" },
        newBranchName: "   ",
        placeholderName: "steady-silver-fox",
      }),
    ).toBeNull();
  });

  it("ignores an explicit field value when another ref is selected", () => {
    expect(
      resolveRequestedNewBranchSlug({
        selectedItem: { kind: "branch", name: "main" },
        newBranchName: "Hidden Value",
        placeholderName: "steady-silver-fox",
      }),
    ).toBeNull();
  });

  it("uses an explicit field value before the placeholder", () => {
    expect(
      resolveRequestedNewBranchSlug({
        selectedItem: { kind: "new-branch" },
        newBranchName: "Feature Korea",
        placeholderName: "steady-silver-fox",
      }),
    ).toBe("feature-korea");
  });
});

describe("resolveNewBranchError", () => {
  it("allows an empty new branch field when the placeholder is valid", () => {
    expect(
      resolveNewBranchError({
        rawName: "",
        requestedSlug: "steady-silver-fox",
        isNewBranchSelected: true,
        invalidLabel: "Invalid branch name",
      }),
    ).toBeNull();
  });

  it("keeps an empty field neutral when another ref is selected", () => {
    expect(
      resolveNewBranchError({
        rawName: "",
        requestedSlug: null,
        isNewBranchSelected: false,
        invalidLabel: "Invalid branch name",
      }),
    ).toBeNull();
  });
});
