/** A rail needs summary status; the selected content additionally needs timeline data. */
export function pullRequestDemand(active: boolean, consumer: "rail" | "content") {
  return { enabled: active, timelineEnabled: active && consumer === "content" };
}
export function shouldDiscoverPullRequest(input: {
  workspaceActive: boolean;
  isGit: boolean;
  splitLayout: boolean;
  explorerActive: boolean;
}): boolean {
  return input.workspaceActive && input.isGit && (input.splitLayout || input.explorerActive);
}
