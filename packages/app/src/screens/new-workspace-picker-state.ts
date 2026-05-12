import type { UserComposerAttachment } from "@/attachments/types";
import type { PickerItem } from "./new-workspace-picker-item";

export interface PickerSelection {
  item: PickerItem;
  // PR number whose attachment the picker created (and therefore owns). `null` when
  // the picker is on a branch, or when the picker reflects a PR attachment that was
  // already there (manual dedup or auto-promotion).
  attachedPrNumber: number | null;
  // How the selection got there: "manual" if the user clicked it in the ref picker,
  // "attachment" if it was auto-promoted from a single PR attachment in the composer.
  source: "manual" | "attachment";
}

// The picker "owns" at most one PR attachment at a time. When the user selects
// a different item the previously-owned PR is removed before the new one is added.
// User-added attachments for other PRs/issues are left untouched.
export function syncPickerPrAttachment(input: {
  attachments: UserComposerAttachment[];
  previousPickerPrNumber: number | null;
  item: PickerItem;
}): { attachments: UserComposerAttachment[]; attachedPrNumber: number | null } {
  let nextAttachments = input.attachments;
  let attachedPrNumber: number | null = null;

  if (input.previousPickerPrNumber !== null) {
    nextAttachments = nextAttachments.filter(
      (attachment) =>
        attachment.kind !== "github_pr" || attachment.item.number !== input.previousPickerPrNumber,
    );
  }

  if (input.item.kind === "github-pr") {
    const selectedPr = input.item.item;
    const hasExistingPrAttachment = nextAttachments.some(
      (attachment) =>
        attachment.kind === "github_pr" && attachment.item.number === selectedPr.number,
    );
    if (!hasExistingPrAttachment) {
      nextAttachments = [...nextAttachments, { kind: "github_pr", item: selectedPr }];
      attachedPrNumber = selectedPr.number;
    }
  }

  return { attachments: nextAttachments, attachedPrNumber };
}

// Auto-promote a single attached PR into the ref picker. A user who attached
// exactly one PR and didn't touch the ref picker almost always wants the
// worktree based on that PR — surface it instead of silently branching off main.
// Manual picker selections are never overridden. Auto-promoted selections are
// cleared when their backing attachment goes away.
export function derivePickerSelectionFromAttachments(input: {
  attachments: ReadonlyArray<UserComposerAttachment>;
  current: PickerSelection | null;
}): PickerSelection | null {
  if (input.current?.source === "manual") {
    return input.current;
  }

  const prAttachments = input.attachments.filter(
    (attachment): attachment is Extract<UserComposerAttachment, { kind: "github_pr" }> =>
      attachment.kind === "github_pr",
  );

  if (input.current?.source === "attachment" && input.current.item.kind === "github-pr") {
    const currentNumber = input.current.item.item.number;
    if (prAttachments.some((attachment) => attachment.item.number === currentNumber)) {
      return input.current;
    }
  }

  if (prAttachments.length !== 1) {
    return null;
  }

  return {
    item: { kind: "github-pr", item: prAttachments[0].item },
    attachedPrNumber: null,
    source: "attachment",
  };
}
