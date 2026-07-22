import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  clearPickerPrAttachmentForTargetChange,
  initialPickerSelectionState,
  reducePickerSelection,
  syncPickerPrAttachment,
} from "./new-workspace-picker-state";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";

function makePrItem(number: number, title: string, headRefName = "feature/x"): ForgeSearchItem {
  return {
    kind: "change_request",
    number,
    title,
    url: `https://example.com/pull/${number}`,
    state: "open",
    body: null,
    labels: [],
    baseRefName: "main",
    headRefName,
  };
}

function prAttachment(
  item: ForgeSearchItem,
  owner?: "new-workspace-picker",
): Extract<UserComposerAttachment, { kind: "github_pr" }> {
  return { kind: "github_pr", item, ...(owner ? { owner } : {}) };
}

function forgePrAttachment(
  item: ForgeSearchItem,
): Extract<UserComposerAttachment, { kind: "forge_change_request" }> {
  return { kind: "forge_change_request", item };
}

function makeIssueItem(number: number): ForgeSearchItem {
  return {
    kind: "issue",
    number,
    title: `Issue ${number}`,
    url: `https://example.com/issues/${number}`,
    state: "open",
    body: null,
    labels: [],
  };
}

function issueAttachment(number: number): UserComposerAttachment {
  return { kind: "github_issue", item: makeIssueItem(number) };
}

describe("syncPickerPrAttachment", () => {
  it("selects a PR when no previous picker PR is set", () => {
    const pr = makePrItem(202, "Refactor picker");
    const result = syncPickerPrAttachment({
      attachments: [],
      item: { kind: "github-pr", item: pr },
    });
    expect(result).toEqual([prAttachment(pr, "new-workspace-picker")]);
  });

  it("selects a branch without modifying attachments when no previous picker PR", () => {
    const issue = issueAttachment(44);
    const result = syncPickerPrAttachment({
      attachments: [issue],
      item: { kind: "branch", name: "dev" },
    });
    expect(result).toEqual([issue]);
  });

  it("replaces the previous picker PR when a different PR is selected", () => {
    const prA = makePrItem(202, "Refactor picker", "feature/picker");
    const prB = makePrItem(303, "Polish chip", "feature/chip");
    const result = syncPickerPrAttachment({
      attachments: [prAttachment(prA, "new-workspace-picker")],
      item: { kind: "github-pr", item: prB },
    });
    expect(result).toEqual([prAttachment(prB, "new-workspace-picker")]);
  });

  it("removes the previous picker PR and adds no new attachment when a branch is selected", () => {
    const pr = makePrItem(202, "Refactor picker");
    const issue = issueAttachment(44);
    const result = syncPickerPrAttachment({
      attachments: [issue, prAttachment(pr, "new-workspace-picker")],
      item: { kind: "branch", name: "dev" },
    });
    expect(result).toEqual([issue]);
  });

  it("does not duplicate a PR that was already manually attached by the user", () => {
    const pr = makePrItem(202, "Refactor picker");
    const result = syncPickerPrAttachment({
      attachments: [prAttachment(pr)],
      item: { kind: "github-pr", item: pr },
    });
    expect(result).toEqual([prAttachment(pr)]);
  });

  it("does not duplicate a generalized PR attachment", () => {
    const pr = makePrItem(202, "Refactor picker");
    const result = syncPickerPrAttachment({
      attachments: [forgePrAttachment(pr)],
      item: { kind: "github-pr", item: pr },
    });
    expect(result).toEqual([forgePrAttachment(pr)]);
  });

  it("clears a persisted picker selection without removing user-added attachments", () => {
    const pickerPr = prAttachment(makePrItem(202, "Picker PR"), "new-workspace-picker");
    const manuallyAttachedPr = prAttachment(makePrItem(303, "Manual PR"));
    const issue = issueAttachment(44);

    const result = syncPickerPrAttachment({
      attachments: [issue, pickerPr, manuallyAttachedPr],
      item: null,
    });

    expect(result).toEqual([issue, manuallyAttachedPr]);
  });
});

describe("clearPickerPrAttachmentForTargetChange", () => {
  it("keeps the picker selection when the target is reselected", () => {
    const pickerPr = prAttachment(makePrItem(202, "Picker PR"), "new-workspace-picker");
    const attachments = [pickerPr];

    expect(
      clearPickerPrAttachmentForTargetChange({
        attachments,
        currentTargetId: "server-a",
        nextTargetId: "server-a",
      }),
    ).toBe(attachments);
  });

  it("clears all PR attachments when the target changes", () => {
    const pickerPr = prAttachment(makePrItem(202, "Picker PR"), "new-workspace-picker");
    const manualPr = prAttachment(makePrItem(303, "Manual PR"));
    const forgePr = forgePrAttachment(makePrItem(404, "Forge PR"));
    const issue = issueAttachment(44);

    expect(
      clearPickerPrAttachmentForTargetChange({
        attachments: [issue, pickerPr, manualPr, forgePr],
        currentTargetId: "server-a",
        nextTargetId: "server-b",
      }),
    ).toEqual([issue]);
  });
});

describe("reducePickerSelection", () => {
  it("selects a PR that was newly detected and added", () => {
    const item = { kind: "github-pr" as const, item: makePrItem(101, "A") };
    const detected = reducePickerSelection(initialPickerSelectionState, { type: "pr-detected" });

    expect(reducePickerSelection(detected, { type: "pr-added", item })).toEqual({
      selectedItem: item,
      allowAutoPrSelection: false,
    });
  });

  it("keeps the first PR selected when one edit adds multiple PRs", () => {
    const detected = reducePickerSelection(initialPickerSelectionState, { type: "pr-detected" });
    const first = reducePickerSelection(detected, {
      type: "pr-added",
      item: { kind: "github-pr", item: makePrItem(101, "A") },
    });

    expect(
      reducePickerSelection(first, {
        type: "pr-added",
        item: { kind: "github-pr", item: makePrItem(202, "B") },
      }),
    ).toEqual(first);
  });

  it("keeps a branch selected after a pending PR is added", () => {
    const detected = reducePickerSelection(initialPickerSelectionState, { type: "pr-detected" });
    const branchSelected = reducePickerSelection(detected, {
      type: "picker-selected",
      item: { kind: "branch", name: "main" },
    });

    expect(
      reducePickerSelection(branchSelected, {
        type: "pr-added",
        item: { kind: "github-pr", item: makePrItem(101, "A") },
      }),
    ).toEqual(branchSelected);
  });

  it("does not derive checkout selection from an existing attachment", () => {
    expect(
      reducePickerSelection(initialPickerSelectionState, {
        type: "pr-added",
        item: { kind: "github-pr", item: makePrItem(101, "A") },
      }),
    ).toEqual(initialPickerSelectionState);
  });

  it("lets a newly detected PR replace an earlier explicit branch", () => {
    const branchSelected = reducePickerSelection(initialPickerSelectionState, {
      type: "picker-selected",
      item: { kind: "branch", name: "main" },
    });
    const detected = reducePickerSelection(branchSelected, { type: "pr-detected" });
    const pr = { kind: "github-pr" as const, item: makePrItem(101, "A") };

    expect(reducePickerSelection(detected, { type: "pr-added", item: pr }).selectedItem).toEqual(
      pr,
    );
  });
});
