import { usePullRequestData } from "@/panels/pull-request";

export function usePullRequestPanelAvailability(input: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  requested: boolean;
  enabled: boolean;
  timelineEnabled?: boolean;
}) {
  const canQuery = input.isGit && Boolean(input.cwd);
  const prPane = usePullRequestData({
    serverId: input.serverId,
    cwd: input.cwd,
    enabled: canQuery && input.enabled,
    timelineEnabled: canQuery && input.enabled && Boolean(input.timelineEnabled),
  });
  return {
    prPane,
    showPullRequest: prPane.prNumber !== null || (input.requested && prPane.isLoading),
  };
}
