import { GitPullRequest } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { formatPrTabLabel } from "@/git/pull-request-panel/tab-label";
import type { PanelPresentation } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useRetainedPullRequestData } from "./data";
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
export const pullRequestPanelPresentation = {
  label: (t) => t("panels.pullRequest.label"),
  subtitle: (t) => t("panels.pullRequest.subtitle"),
  tooltip: (t) => t("panels.pullRequest.label"),
  icon: ThemedGitPullRequest,
} satisfies PanelPresentation;
export function usePullRequestPanelDescriptor(
  _target: { kind: "pull_request" },
  context: { serverId: string; workspaceId: string },
) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(context.serverId, context.workspaceId) ?? "";
  const prPane = useRetainedPullRequestData(
    {
      serverId: context.serverId,
      cwd,
    },
    "rail",
  );
  const label =
    prPane.prNumber === null
      ? pullRequestPanelPresentation.label(t)
      : formatPrTabLabel(prPane.prNumber);
  return {
    label,
    subtitle: pullRequestPanelPresentation.subtitle(t),
    tooltip: label,
    titleState: prPane.isLoading ? ("loading" as const) : ("ready" as const),
    icon: pullRequestPanelPresentation.icon,
    statusBucket: null,
  };
}
