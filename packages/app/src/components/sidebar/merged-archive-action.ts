import type { PrHint } from "@/git/pr-hint";

/**
 * A merged change request is the one workspace state with an obvious next action, and it is
 * the same action every time. Showing it costs one glyph on a line that already says "Merged",
 * and saves opening the kebab on every row you finish.
 *
 * Always visible rather than hover-to-show: it is the row's conclusion, not one of several
 * things you might do to it, and hover doesn't exist on native (docs/hover.md).
 */
export function shouldShowMergedArchiveAction({
  prHint,
  hasArchiveAction,
  archiveStatus,
}: {
  prHint: PrHint | null;
  hasArchiveAction: boolean;
  archiveStatus: "idle" | "pending" | "success";
}): boolean {
  return prHint?.state === "merged" && hasArchiveAction && archiveStatus === "idle";
}
