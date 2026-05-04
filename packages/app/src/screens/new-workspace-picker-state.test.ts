import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { GitHubSearchItem } from "@server/shared/messages";
import { syncPickerPrAttachment } from "./new-workspace-picker-state";

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

function prAttachment(item: GitHubSearchItem): UserComposerAttachment {
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
