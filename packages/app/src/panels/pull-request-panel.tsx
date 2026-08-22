import { Text, View } from "react-native";
import { GitPullRequest } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { formatPrTabLabel } from "@/git/pull-request-panel";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { PullRequestContent, usePullRequestData } from "@/panels/pull-request";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function usePullRequestPanelDescriptor(
  _target: { kind: "pull_request" },
  context: { serverId: string; workspaceId: string },
) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(context.serverId, context.workspaceId) ?? "";
  const prPane = usePullRequestData({ serverId: context.serverId, cwd, timelineEnabled: false });
  const label =
    prPane.prNumber === null ? t("panels.pullRequest.label") : formatPrTabLabel(prPane.prNumber);
  return {
    label,
    subtitle: t("panels.pullRequest.subtitle"),
    tooltip: label,
    titleState: prPane.isLoading ? ("loading" as const) : ("ready" as const),
    icon: ThemedGitPullRequest,
    statusBucket: null,
  };
}

function PullRequestPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  invariant(target.kind === "pull_request", "PullRequestPanel requires pull_request target");
  const prPane = usePullRequestData({ serverId, cwd });
  if (!cwd) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <PullRequestContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} prPane={prPane} />
  );
}

export const pullRequestPanelRegistration: PanelRegistration<"pull_request"> = {
  kind: "pull_request",
  resourceKey: () => "pull_request",
  component: PullRequestPanel,
  useDescriptor: usePullRequestPanelDescriptor,
};
