import { createLongNameId } from "mnemonic-id";
import { slugify, validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import type { PickerItem } from "./new-workspace-picker-item";

const PLACEHOLDER_RETRY_LIMIT = 8;

export function createNewBranchPlaceholderName(input?: {
  previousName?: string | null;
  createName?: () => string;
}): string {
  const previousName = input?.previousName ?? null;
  const createName = input?.createName ?? createLongNameId;

  for (let attempt = 0; attempt < PLACEHOLDER_RETRY_LIMIT; attempt += 1) {
    const candidate = slugify(createName());
    if (candidate && candidate !== previousName) {
      return candidate;
    }
  }

  return slugify(createLongNameId());
}

export function resolveRequestedNewBranchSlug(input: {
  selectedItem: PickerItem | null;
  newBranchName: string;
  placeholderName: string;
}): string | null {
  if (input.selectedItem?.kind !== "new-branch") {
    return null;
  }
  if (input.newBranchName.trim().length > 0) {
    return slugify(input.newBranchName);
  }
  return input.placeholderName;
}

export function resolveNewBranchError(input: {
  rawName: string;
  requestedSlug: string | null;
  isNewBranchSelected: boolean;
  invalidLabel: string;
}): string | null {
  const shouldValidate = input.rawName.trim().length > 0 || input.isNewBranchSelected;
  if (!shouldValidate) {
    return null;
  }
  const validation = validateBranchSlug(input.requestedSlug ?? "");
  return validation.valid ? null : input.invalidLabel;
}
