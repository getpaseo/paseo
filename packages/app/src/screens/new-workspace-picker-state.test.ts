import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import type { GitHubSearchItem } from "@server/shared/messages";
import {
  derivePickerSelectionFromAttachments,
  type PickerSelection,
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

describe("derivePickerSelectionFromAttachments", () => {
  function manualBranch(name: string): PickerSelection {
    return { item: { kind: "branch", name }, attachedPrNumber: null, source: "manual" };
  }

  function manualPr(pr: GitHubSearchItem, ownsAttachment: boolean): PickerSelection {
    return {
      item: { kind: "github-pr", item: pr },
      attachedPrNumber: ownsAttachment ? pr.number : null,
      source: "manual",
    };
  }

  function autoPr(pr: GitHubSearchItem): PickerSelection {
    return {
      item: { kind: "github-pr", item: pr },
      attachedPrNumber: null,
      source: "attachment",
    };
  }

  it("returns null when there are no attachments and nothing is selected", () => {
    expect(derivePickerSelectionFromAttachments({ attachments: [], current: null })).toBeNull();
  });

  it("auto-promotes a single PR attachment when nothing is selected", () => {
    const pr = makePrItem(923, "Nix overridable npm deps hash");
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(pr)],
      current: null,
    });
    expect(result).toEqual(autoPr(pr));
  });

  it("does not auto-promote when multiple PRs are attached", () => {
    const a = makePrItem(101, "A");
    const b = makePrItem(202, "B");
    expect(
      derivePickerSelectionFromAttachments({
        attachments: [prAttachment(a), prAttachment(b)],
        current: null,
      }),
    ).toBeNull();
  });

  it("preserves a manual branch selection even when a PR is attached", () => {
    const pr = makePrItem(923, "Nix overridable npm deps hash");
    const current = manualBranch("main");
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(pr)],
      current,
    });
    expect(result).toBe(current);
  });

  it("preserves a manual PR selection when other PRs become attached", () => {
    const picked = makePrItem(101, "Picked");
    const extra = makePrItem(202, "Extra");
    const current = manualPr(picked, true);
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(picked), prAttachment(extra)],
      current,
    });
    expect(result).toBe(current);
  });

  it("keeps the auto-promoted PR while its attachment is still present", () => {
    const pr = makePrItem(923, "Nix overridable npm deps hash");
    const current = autoPr(pr);
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(pr)],
      current,
    });
    expect(result).toBe(current);
  });

  it("clears the auto-promoted selection when its attachment is removed", () => {
    const pr = makePrItem(923, "Nix overridable npm deps hash");
    const result = derivePickerSelectionFromAttachments({
      attachments: [],
      current: autoPr(pr),
    });
    expect(result).toBeNull();
  });

  it("re-promotes a different PR when the auto-promoted one is replaced", () => {
    const a = makePrItem(101, "A");
    const b = makePrItem(202, "B");
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(b)],
      current: autoPr(a),
    });
    expect(result).toEqual(autoPr(b));
  });

  it("does not auto-promote when the auto-promoted PR is gone and ambiguity arises", () => {
    const a = makePrItem(101, "A");
    const b = makePrItem(202, "B");
    const c = makePrItem(303, "C");
    const result = derivePickerSelectionFromAttachments({
      attachments: [prAttachment(b), prAttachment(c)],
      current: autoPr(a),
    });
    expect(result).toBeNull();
  });

  it("ignores non-PR attachments", () => {
    const issue = issueAttachment(44);
    expect(
      derivePickerSelectionFromAttachments({ attachments: [issue], current: null }),
    ).toBeNull();
  });
});
