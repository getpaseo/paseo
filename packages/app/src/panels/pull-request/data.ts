import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePrPaneData } from "@/git/pull-request-panel/use-data";
import { pullRequestDemand } from "./activity";
export { usePrPaneData as usePullRequestData } from "@/git/pull-request-panel/use-data";
export function useRetainedPullRequestData(
  input: { serverId: string; cwd: string },
  role: "rail" | "content",
) {
  const active = useRetainedPanelActive();
  return usePrPaneData({ ...input, ...pullRequestDemand(active, role) });
}
