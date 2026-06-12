import type { PullRequestReviewThreadsError } from "@/git/use-pr-review-threads-query";

// Maps a structured fetch error to a translation key. Pure so the branch logic
// is testable without React or i18n. Returns null when there is no error.
export function reviewThreadsErrorMessageKey(
  payloadError: PullRequestReviewThreadsError | null,
  queryError: Error | null,
): string | null {
  if (payloadError) {
    switch (payloadError.kind) {
      case "missing_cli":
        return "workspace.git.pr.reviewComments.errors.missingCli";
      case "auth_required":
        return "workspace.git.pr.reviewComments.errors.authRequired";
      case "forbidden":
        return "workspace.git.pr.reviewComments.errors.forbidden";
      case "not_found":
        return "workspace.git.pr.reviewComments.errors.notFound";
      default:
        return "workspace.git.pr.reviewComments.errors.unknown";
    }
  }
  if (queryError) {
    return "workspace.git.pr.reviewComments.errors.unknown";
  }
  return null;
}
