import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  clearPickerPrAttachmentForTargetChange,
  pickerItemFromLatestPrAttachment,
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

describe("pickerItemFromLatestPrAttachment", () => {
  it("restores a forge change request attachment as the starting ref", () => {
    const item = makePrItem(101, "A");

    expect(pickerItemFromLatestPrAttachment([forgePrAttachment(item)])).toEqual({
      kind: "github-pr",
      item,
    });
  });

  it("restores a legacy GitHub PR attachment as the starting ref", () => {
    const item = makePrItem(101, "A");

    expect(pickerItemFromLatestPrAttachment([prAttachment(item)])).toEqual({
      kind: "github-pr",
      item,
    });
  });

  it("ignores issue attachments", () => {
    expect(pickerItemFromLatestPrAttachment([issueAttachment(44)])).toBeNull();
  });

  it("restores the most recently attached PR", () => {
    const first = forgePrAttachment(makePrItem(101, "A"));
    const second = forgePrAttachment(makePrItem(202, "B"));

    expect(pickerItemFromLatestPrAttachment([first, second])).toEqual({
      kind: "github-pr",
      item: second.item,
    });
  });
});
