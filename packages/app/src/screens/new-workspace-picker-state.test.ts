import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import { findCheckoutHintPrAttachment, syncPickerPrAttachment } from "./new-workspace-picker-state";

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
): Extract<UserComposerAttachment, { kind: "github_pr" }> {
  return { kind: "github_pr", item };
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
      previousPickerPrNumber: null,
      item: { kind: "github-pr", item: pr },
    });
    expect(result.attachedPrNumber).toBe(202);
    expect(result.attachments).toEqual([prAttachment(pr)]);
  });

  it("selects a branch without modifying attachments when no previous picker PR", () => {
    const issue = issueAttachment(44);
    const result = syncPickerPrAttachment({
      attachments: [issue],
      previousPickerPrNumber: null,
      item: { kind: "branch", name: "dev" },
    });
    expect(result.attachedPrNumber).toBeNull();
    expect(result.attachments).toEqual([issue]);
  });

  it("replaces the previous picker PR when a different PR is selected", () => {
    const prA = makePrItem(202, "Refactor picker", "feature/picker");
    const prB = makePrItem(303, "Polish chip", "feature/chip");
    const result = syncPickerPrAttachment({
      attachments: [prAttachment(prA)],
      previousPickerPrNumber: 202,
      item: { kind: "github-pr", item: prB },
    });
    expect(result.attachedPrNumber).toBe(303);
    expect(result.attachments).toEqual([prAttachment(prB)]);
  });

  it("removes the previous picker PR and adds no new attachment when a branch is selected", () => {
    const pr = makePrItem(202, "Refactor picker");
    const issue = issueAttachment(44);
    const result = syncPickerPrAttachment({
      attachments: [issue, prAttachment(pr)],
      previousPickerPrNumber: 202,
      item: { kind: "branch", name: "dev" },
    });
    expect(result.attachedPrNumber).toBeNull();
    expect(result.attachments).toEqual([issue]);
  });

  it("does not duplicate a PR that was already manually attached by the user", () => {
    const pr = makePrItem(202, "Refactor picker");
    const result = syncPickerPrAttachment({
      attachments: [prAttachment(pr)],
      previousPickerPrNumber: null,
      item: { kind: "github-pr", item: pr },
    });
    expect(result.attachedPrNumber).toBeNull();
    expect(result.attachments).toHaveLength(1);
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
