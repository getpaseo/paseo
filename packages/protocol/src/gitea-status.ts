/**
 * Maps a Gitea/Forgejo commit-status state (individual status or the combined
 * aggregate, e.g. a forge fact's ciStatus) onto the neutral check status.
 * Shared by the daemon's Gitea adapter and the app's Gitea forge module so the
 * "warning is terminal and non-passing" rule lives in one place: upstream
 * treats warning as IsSuccess() == false, so it blocks merges and must not
 * render as a plain pass or hang as pending.
 */
export function mapGiteaCommitState(state: string): "success" | "failure" | "pending" | "skipped" {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
    case "warning":
      return "failure";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}
