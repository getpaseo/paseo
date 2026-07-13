import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import {
  clearPickerPrAttachmentForTargetChange,
  findCheckoutHintPrAttachment,
  syncPickerPrAttachment,
} from "./new-workspace-picker-state";

function makePrItem(number: number, title: string, headRefName = "feature/x"): GitHubSearchItem {
  return {
    kind: "pr",
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
  item: GitHubSearchItem,
  owner?: "new-workspace-picker",
): Extract<UserComposerAttachment, { kind: "github_pr" }> {
  return { kind: "github_pr", item, ...(owner ? { owner } : {}) };
}

function issueAttachment(number: number): UserComposerAttachment {
  return {
    kind: "github_issue",
    item: {
      kind: "issue",
      number,
      title: `Issue ${number}`,
      url: `https://example.com/issues/${number}`,
      state: "open",
      body: null,
      labels: [],
    },
  };
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

  it("clears only the picker-owned PR when the target changes", () => {
    const pickerPr = prAttachment(makePrItem(202, "Picker PR"), "new-workspace-picker");
    const manualPr = prAttachment(makePrItem(303, "Manual PR"));

    expect(
      clearPickerPrAttachmentForTargetChange({
        attachments: [pickerPr, manualPr],
        currentTargetId: "server-a",
        nextTargetId: "server-b",
      }),
    ).toEqual([manualPr]);
  });
});

describe("findCheckoutHintPrAttachment", () => {
  it("returns the first attached PR that is not selected or dismissed", () => {
    const first = prAttachment(makePrItem(101, "A"));
    const second = prAttachment(makePrItem(202, "B"));

    expect(
      findCheckoutHintPrAttachment({
        attachments: [issueAttachment(44), first, second],
        selectedItem: null,
        dismissedPrNumbers: new Set(),
      }),
    ).toBe(first);
  });

  it("skips the selected PR and offers the next attached PR", () => {
    const selected = prAttachment(makePrItem(101, "A"));
    const next = prAttachment(makePrItem(202, "B"));

    expect(
      findCheckoutHintPrAttachment({
        attachments: [selected, next],
        selectedItem: { kind: "github-pr", item: selected.item },
        dismissedPrNumbers: new Set(),
      }),
    ).toBe(next);
  });

  it("skips dismissed PRs and ignores issues", () => {
    const dismissed = prAttachment(makePrItem(101, "A"));
    const next = prAttachment(makePrItem(202, "B"));

    expect(
      findCheckoutHintPrAttachment({
        attachments: [issueAttachment(44), dismissed, next],
        selectedItem: null,
        dismissedPrNumbers: new Set([101]),
      }),
    ).toBe(next);
  });

  it("returns null when only issues qualify", () => {
    expect(
      findCheckoutHintPrAttachment({
        attachments: [issueAttachment(44)],
        selectedItem: null,
        dismissedPrNumbers: new Set(),
      }),
    ).toBeNull();
  });
});
