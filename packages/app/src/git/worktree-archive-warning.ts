import { confirmDialog } from "@/utils/confirm-dialog";

export interface WorktreeArchiveRisk {
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
}

export interface WorktreeArchiveConfirmationInput extends WorktreeArchiveRisk {
  worktreeName: string;
}

export interface WorktreeArchiveWarningLabels {
  title: (worktreeName: string) => string;
  confirm: string;
  cancel: string;
  uncommittedChanges: string;
  uncommittedChangesWithDiff: (diffStat: string) => string;
  addedLine: (count: number) => string;
  deletedLine: (count: number) => string;
  unpushedCommit: (count: number) => string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export const DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS: WorktreeArchiveWarningLabels = {
  title: (worktreeName) => `Archive "${worktreeName}"?`,
  confirm: "Archive",
  cancel: "Cancel",
  uncommittedChanges: "Uncommitted changes",
  uncommittedChangesWithDiff: (diffStat) => `Uncommitted changes (${diffStat})`,
  addedLine: (count) => `${count} added ${pluralize(count, "line")}`,
  deletedLine: (count) => `${count} deleted ${pluralize(count, "line")}`,
  unpushedCommit: (count) => `${count} unpushed ${pluralize(count, "commit")}`,
};

function formatDiffStat(
  diffStat: WorktreeArchiveRisk["diffStat"],
  labels: WorktreeArchiveWarningLabels,
): string | null {
  if (!diffStat) {
    return null;
  }

  const parts: string[] = [];
  if (diffStat.additions > 0) {
    parts.push(labels.addedLine(diffStat.additions));
  }
  if (diffStat.deletions > 0) {
    parts.push(labels.deletedLine(diffStat.deletions));
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

export function buildWorktreeArchiveRiskReasons(
  input: WorktreeArchiveRisk,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): string[] {
  const reasons: string[] = [];
  const diffStat = input.diffStat;
  const hasDiffStatChanges = diffStat ? diffStat.additions > 0 || diffStat.deletions > 0 : false;
  const hasUncommittedChanges =
    input.isDirty === true || (input.isDirty == null && hasDiffStatChanges);

  if (hasUncommittedChanges) {
    const diffStatLabel = formatDiffStat(diffStat, labels);
    reasons.push(
      diffStatLabel ? labels.uncommittedChangesWithDiff(diffStatLabel) : labels.uncommittedChanges,
    );
  }

  if ((input.aheadOfOrigin ?? 0) > 0) {
    const aheadOfOrigin = input.aheadOfOrigin ?? 0;
    reasons.push(labels.unpushedCommit(aheadOfOrigin));
  }

  return reasons;
}

export function buildWorktreeArchiveConfirmationMessage(
  input: WorktreeArchiveConfirmationInput,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): string | null {
  const reasons = buildWorktreeArchiveRiskReasons(input, labels);
  if (reasons.length === 0) {
    return null;
  }

  return reasons.join("\n");
}

export async function confirmRiskyWorktreeArchive(
  input: WorktreeArchiveConfirmationInput,
  labels: WorktreeArchiveWarningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
): Promise<boolean> {
  const message = buildWorktreeArchiveConfirmationMessage(input, labels);
  if (!message) {
    return true;
  }

  return await confirmDialog({
    title: labels.title(input.worktreeName),
    message,
    confirmLabel: labels.confirm,
    cancelLabel: labels.cancel,
    destructive: true,
  });
}
