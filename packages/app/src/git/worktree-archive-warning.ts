import { confirmDialog } from "@/utils/confirm-dialog";
import { i18n } from "@/i18n/i18next";

export type OriginDefaultRelationState =
  | "exact"
  | "included"
  | "ahead"
  | "patch_equivalent_not_included"
  | "diverged_with_unique_commits"
  | "unverifiable";

export interface OriginDefaultRelation {
  state: OriginDefaultRelationState;
  resolvedRef: string | null;
  ahead: number | null;
  behind: number | null;
  uniquePatchCount: number | null;
}

export interface WorktreeArchiveRisk {
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  originDefaultRelation?: OriginDefaultRelation | null;
  diffStat?: { additions: number; deletions: number } | null;
}

export interface WorktreeArchiveRiskInput {
  archiveHasUncommittedChanges?: boolean | null;
  archiveUnpushedCommitCount?: number | null;
  archiveOriginDefaultRelation?: OriginDefaultRelation | null;
  diffStat?: WorktreeArchiveRisk["diffStat"];
}

export interface WorktreeArchiveConfirmationInput extends WorktreeArchiveRisk {
  workspaceName: string;
}

export interface WorktreeArchiveWarningLabels {
  title: (workspaceName: string) => string;
  confirm: string;
  cancel: string;
  uncommittedChanges: string;
  uncommittedChangesWithDiff: (diffStat: string) => string;
  addedLine: (count: number) => string;
  deletedLine: (count: number) => string;
  unpushedCommit: (count: number) => string;
  includedInOriginDefault: (resolvedRef: string) => string;
  patchEquivalentToOriginDefault: (resolvedRef: string) => string;
}

function defaultResolvedRefLabel(resolvedRef: string | null | undefined): string {
  return resolvedRef && resolvedRef.length > 0 ? resolvedRef : "origin/default";
}

export const DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS: WorktreeArchiveWarningLabels = {
  title: (workspaceName) => i18n.t("workspace.git.actions.archiveWarning.title", { workspaceName }),
  confirm: i18n.t("workspace.git.actions.archiveWarning.confirm"),
  cancel: i18n.t("workspace.git.actions.archiveWarning.cancel"),
  uncommittedChanges: i18n.t("workspace.git.actions.archiveWarning.uncommittedChanges"),
  uncommittedChangesWithDiff: (diffStat) =>
    i18n.t("workspace.git.actions.archiveWarning.uncommittedChangesWithDiff", { diffStat }),
  addedLine: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.addedLine", { count })
      : i18n.t("workspace.git.actions.archiveWarning.addedLines", { count }),
  deletedLine: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.deletedLine", { count })
      : i18n.t("workspace.git.actions.archiveWarning.deletedLines", { count }),
  unpushedCommit: (count) =>
    count === 1
      ? i18n.t("workspace.git.actions.archiveWarning.unpushedCommit", { count })
      : i18n.t("workspace.git.actions.archiveWarning.unpushedCommits", { count }),
  includedInOriginDefault: (resolvedRef) =>
    i18n.t("workspace.git.actions.archiveWarning.includedInOriginDefault", {
      resolvedRef: defaultResolvedRefLabel(resolvedRef),
    }),
  patchEquivalentToOriginDefault: (resolvedRef) =>
    i18n.t("workspace.git.actions.archiveWarning.patchEquivalentToOriginDefault", {
      resolvedRef: defaultResolvedRefLabel(resolvedRef),
    }),
};

export function toWorktreeArchiveRisk(input: WorktreeArchiveRiskInput): WorktreeArchiveRisk {
  return {
    isDirty: input.archiveHasUncommittedChanges,
    aheadOfOrigin: input.archiveUnpushedCommitCount,
    originDefaultRelation: input.archiveOriginDefaultRelation,
    diffStat: input.diffStat,
  };
}

/**
 * Classify how origin-default relation affects archive push risk messaging.
 * Missing relation (old daemon) preserves legacy aheadOfOrigin behavior.
 */
export function classifyOriginDefaultArchivePushRisk(
  relation: OriginDefaultRelation | null | undefined,
): "included" | "patch_equivalent" | "risky" | "unknown" {
  if (!relation) {
    return "unknown";
  }
  switch (relation.state) {
    case "exact":
    case "included":
      return "included";
    case "patch_equivalent_not_included":
      return "patch_equivalent";
    case "ahead":
    case "diverged_with_unique_commits":
    case "unverifiable":
      return "risky";
    default:
      return "unknown";
  }
}

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

  const aheadOfOrigin = input.aheadOfOrigin ?? 0;
  const pushRisk = classifyOriginDefaultArchivePushRisk(input.originDefaultRelation);

  if (pushRisk === "included") {
    // Already landed on origin default — encode inclusion instead of unpushed risk.
    // Do not add a protective unpushed reason; optional explicit inclusion label is
    // available via formatOriginDefaultRelationLabel for status UIs.
  } else if (pushRisk === "patch_equivalent") {
    // Visibly distinct and still protected: branch tip is not ancestral inclusion.
    reasons.push(
      labels.patchEquivalentToOriginDefault(
        defaultResolvedRefLabel(input.originDefaultRelation?.resolvedRef),
      ),
    );
  } else if (aheadOfOrigin > 0) {
    // Risky / unknown (missing field from old daemon): legacy unpushed warning.
    reasons.push(labels.unpushedCommit(aheadOfOrigin));
  }

  return reasons;
}

/**
 * Local branch name for the origin-default tip, e.g. `origin/main` → `main`.
 * Returns null when the resolved ref is missing or not an origin/* short ref.
 */
function originDefaultBranchName(resolvedRef: string | null | undefined): string | null {
  if (!resolvedRef || resolvedRef.length === 0) {
    return null;
  }
  if (resolvedRef.startsWith("origin/")) {
    const name = resolvedRef.slice("origin/".length);
    return name.length > 0 ? name : null;
  }
  if (resolvedRef.startsWith("refs/remotes/origin/")) {
    const name = resolvedRef.slice("refs/remotes/origin/".length);
    return name.length > 0 ? name : null;
  }
  return null;
}

/**
 * Ordinary default-branch checkout at the tip: "Included in origin/main" while
 * already on `main` is a tautology. Scope is display-only — classification and
 * archive safety are unchanged.
 */
function isOrdinaryExactDefaultCheckout(
  relation: OriginDefaultRelation,
  currentBranch: string | null | undefined,
): boolean {
  if (relation.state !== "exact") {
    return false;
  }
  if (!currentBranch) {
    return false;
  }
  const defaultBranch = originDefaultBranchName(relation.resolvedRef);
  return defaultBranch !== null && currentBranch === defaultBranch;
}

/** Status/label helper for sidebar and fallbacks — not used as archive land authority. */
export function formatOriginDefaultRelationLabel(
  relation: OriginDefaultRelation | null | undefined,
  labels: Pick<
    WorktreeArchiveWarningLabels,
    "includedInOriginDefault" | "patchEquivalentToOriginDefault" | "unpushedCommit"
  > = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  fallbackAheadOfOrigin?: number | null,
  currentBranch?: string | null,
): string | null {
  if (!relation) {
    if ((fallbackAheadOfOrigin ?? 0) > 0) {
      return labels.unpushedCommit(fallbackAheadOfOrigin ?? 0);
    }
    return null;
  }

  switch (relation.state) {
    case "exact":
      // Suppress tautology on ordinary default-branch checkouts only.
      if (isOrdinaryExactDefaultCheckout(relation, currentBranch)) {
        return null;
      }
      return labels.includedInOriginDefault(defaultResolvedRefLabel(relation.resolvedRef));
    case "included":
      // Feature worktrees/branches included in origin default still show the label.
      return labels.includedInOriginDefault(defaultResolvedRefLabel(relation.resolvedRef));
    case "patch_equivalent_not_included":
      return labels.patchEquivalentToOriginDefault(defaultResolvedRefLabel(relation.resolvedRef));
    case "ahead":
    case "diverged_with_unique_commits":
    case "unverifiable":
      if ((fallbackAheadOfOrigin ?? relation.ahead ?? 0) > 0) {
        return labels.unpushedCommit(fallbackAheadOfOrigin ?? relation.ahead ?? 0);
      }
      return null;
    default:
      return null;
  }
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
    title: labels.title(input.workspaceName),
    message,
    confirmLabel: labels.confirm,
    cancelLabel: labels.cancel,
    destructive: true,
  });
}
