import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { useToast } from "@/contexts/toast-context";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import {
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
  usePrPaneData,
} from "@/git/pull-request-panel";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

import { getPullRequestIdentity, resolvePullRequestContentState } from "./state";

export function usePullRequestAutoAdd(input: {
  workspaceKey: string | null;
  serverId: string;
  cwd: string | null;
  enabled: boolean;
}): void {
  const status = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd || "",
    enabled: input.enabled,
  }).status;
  const observePullRequest = useWorkspaceLayoutStore((state) => state.observePullRequest);
  const identity = getPullRequestIdentity(status);

  useEffect(() => {
    if (input.workspaceKey) {
      observePullRequest(input.workspaceKey, identity);
    }
  }, [identity, input.workspaceKey, observePullRequest]);
}

export function PullRequestContent(input: {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  prPane: UsePrPaneDataResult;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const refresh = useCheckoutGitActionsStore((state) => state.refresh);
  const onRetry = useCallback(() => {
    void refresh({ serverId: input.serverId, cwd: input.cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [input.cwd, input.serverId, refresh, t, toast]);

  if (input.prPane.data) {
    return (
      <PullRequestPane
        serverId={input.serverId}
        cwd={input.cwd}
        data={input.prPane.data}
        activityLoading={input.prPane.activityLoading}
        workspaceAttachmentScopeKey={buildWorkspaceAttachmentScopeKey({
          serverId: input.serverId,
          workspaceId: input.workspaceId,
          cwd: input.cwd,
        })}
      />
    );
  }
  const contentState = resolvePullRequestContentState(input.prPane);
  if (contentState === "error") {
    return <PullRequestPaneError onRetry={onRetry} />;
  }
  if (contentState === "loading") {
    return <PullRequestPaneSkeleton />;
  }
  return (
    <View style={styles.empty} testID="pull-request-empty-state">
      <Text style={styles.emptyTitle}>{t("panels.pullRequest.emptyTitle")}</Text>
      <Text style={styles.emptyDescription}>{t("panels.pullRequest.emptyDescription")}</Text>
    </View>
  );
}

export function usePullRequestData(input: {
  serverId: string;
  cwd: string;
  enabled?: boolean;
  timelineEnabled?: boolean;
}) {
  return usePrPaneData(input);
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
  },
  emptyTitle: {
    color: theme.colors.foreground,
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
  },
}));
