export type BranchComboOption = {
  id: string;
  label: string;
};

export function normalizeBranchOptionName(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed || trimmed === "HEAD") {
    return null;
  }

  let normalized = trimmed;
  if (normalized.startsWith("refs/heads/")) {
    normalized = normalized.slice("refs/heads/".length);
  } else if (normalized.startsWith("refs/remotes/")) {
    normalized = normalized.slice("refs/remotes/".length);
  }
  if (normalized.startsWith("origin/")) {
    normalized = normalized.slice("origin/".length);
  }

  return normalized.length > 0 && normalized !== "HEAD" ? normalized : null;
}

export function buildBranchComboOptions(input: {
  suggestedBranches?: string[];
  currentBranch?: string | null;
  baseRef?: string | null;
  typedBaseBranch?: string | null;
  worktreeBranchLabels?: string[];
}): BranchComboOption[] {
  const branchSet = new Set<string>();
  const addBranch = (name: string | null | undefined) => {
    const normalized = normalizeBranchOptionName(name);
    if (normalized) {
      branchSet.add(normalized);
    }
  };

  for (const branch of input.suggestedBranches ?? []) {
    addBranch(branch);
  }
  addBranch(input.currentBranch ?? null);
  addBranch(input.baseRef ?? null);
  addBranch(input.typedBaseBranch ?? null);
  for (const label of input.worktreeBranchLabels ?? []) {
    addBranch(label);
  }

  return Array.from(branchSet).map((name) => ({ id: name, label: name }));
}
