import { confirmDialog } from "@/utils/confirm-dialog";

export interface WorktreeArchiveRisk {
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
}

export interface WorktreeArchiveConfirmationInput extends WorktreeArchiveRisk {
  worktreeName: string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatDiffStat(diffStat: WorktreeArchiveRisk["diffStat"]): string | null {
  if (!diffStat) {
    return null;
  }

  const parts: string[] = [];
  if (diffStat.additions > 0) {
    parts.push(`${diffStat.additions} added ${pluralize(diffStat.additions, "line")}`);
  }
  if (diffStat.deletions > 0) {
    parts.push(`${diffStat.deletions} deleted ${pluralize(diffStat.deletions, "line")}`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

export function buildWorktreeArchiveRiskReasons(input: WorktreeArchiveRisk): string[] {
  const reasons: string[] = [];
  const diffStat = input.diffStat;
  const hasDiffStatChanges = diffStat ? diffStat.additions > 0 || diffStat.deletions > 0 : false;
  const hasUncommittedChanges =
    input.isDirty === true || (input.isDirty == null && hasDiffStatChanges);

  if (hasUncommittedChanges) {
    const diffStatLabel = formatDiffStat(diffStat);
    reasons.push(diffStatLabel ? `Uncommitted changes (${diffStatLabel})` : "Uncommitted changes");
  }

  if ((input.aheadOfOrigin ?? 0) > 0) {
    const aheadOfOrigin = input.aheadOfOrigin ?? 0;
    reasons.push(`${aheadOfOrigin} unpushed ${pluralize(aheadOfOrigin, "commit")}`);
  }

  return reasons;
}

export function buildWorktreeArchiveConfirmationMessage(
  input: WorktreeArchiveConfirmationInput,
): string | null {
  const reasons = buildWorktreeArchiveRiskReasons(input);
  if (reasons.length === 0) {
    return null;
  }

  return reasons.join("\n");
}

export async function confirmRiskyWorktreeArchive(
  input: WorktreeArchiveConfirmationInput,
): Promise<boolean> {
  const message = buildWorktreeArchiveConfirmationMessage(input);
  if (!message) {
    return true;
  }

  return await confirmDialog({
    title: `Archive "${input.worktreeName}"?`,
    message,
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    destructive: true,
  });
}
