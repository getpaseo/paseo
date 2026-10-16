import { Text } from "react-native";
import { Eye, GitCommitHorizontal, GitPullRequest } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import React, { useCallback, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAgentProfiles } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { launchWorkspaceWorkflowAction, type WorkspaceWorkflowAction } from "@/git/workflow/launch";
import { workspaceWorkflowLabel, type WorkspaceWorkflowState } from "@/git/policy";
import { workspaceWorkflowSelection } from "@/git/workflow/settings-model";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useGitActionRunner, useGitActions } from "@/git/use-actions";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

const ThemedEye = withUnistyles(Eye);
const reviewIconMapping = (theme: Theme) => ({ color: theme.colors.workspace.review });
const reviewIcon = <ThemedEye size={13} strokeWidth={1.5} uniProps={reviewIconMapping} />;

interface WorkspaceActionsProps {
  hideLabels?: boolean;
  serverId: string;
  workspaceId: string;
  cwd: string;
}

function workflowButtonVariant(
  action: WorkspaceWorkflowState["action"],
): "destructive" | "merge" | "archive" | "outline" {
  if (action === "resolve-conflicts") return "destructive";
  if (action === "merge") return "merge";
  if (action === "archive") return "archive";
  return "outline";
}

export function WorkspaceActions({
  serverId,
  workspaceId,
  cwd,
  hideLabels,
}: WorkspaceActionsProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const toast = useToast();
  const runGitAction = useGitActionRunner();
  const client = useHostRuntimeClient(serverId);
  const [launchingAction, setLaunchingAction] = useState<WorkspaceWorkflowAction | null>(null);
  const { config } = useDaemonConfig(serverId);
  const { profiles } = useAgentProfiles(serverId);
  const providerSnapshot = useProvidersSnapshot(serverId, { cwd });
  const conflictModelSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceConflictModel === true,
  );
  const workflowSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceGitWorkflow === true,
  );
  const { commitAction, gitActions, workflowContext, workflowState } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const workflowConfig = useMemo(
    () => config?.workspaceGitWorkflow ?? {},
    [config?.workspaceGitWorkflow],
  );
  const reviewProfile = useMemo(
    () => profiles?.find((profile) => profile.id === workflowConfig.reviewProfileId),
    [profiles, workflowConfig.reviewProfileId],
  );
  const deliveryProfile = useMemo(
    () => profiles?.find((profile) => profile.id === workflowConfig.deliveryProfileId),
    [profiles, workflowConfig.deliveryProfileId],
  );
  const openAgentsSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [router, serverId]);
  const launch = useCallback(
    (action: WorkspaceWorkflowAction) => {
      if (launchingAction) return;
      if (action === "resolve-conflicts" && !conflictModelSupported) {
        toast.error(t("workspace.git.workflow.updateConflictHost"));
        return;
      }
      const profile = action === "review" ? reviewProfile : deliveryProfile;
      const manual = workspaceWorkflowSelection(action, workflowConfig);
      if (!manual && (action === "resolve-conflicts" || !profile)) {
        openAgentsSettings();
        return;
      }
      if (!workflowContext.baseRef) return;
      if (!client && action !== "review") {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }
      if (
        action === "repair-checks" &&
        (!workflowContext.pullRequestUrl || !workflowContext.branch)
      ) {
        return;
      }
      setLaunchingAction(action);
      void launchWorkspaceWorkflowAction({
        action,
        client,
        serverId,
        workspaceId,
        cwd: workflowContext.cwd,
        baseRef: workflowContext.baseRef,
        branch: workflowContext.branch,
        prUrl: workflowContext.pullRequestUrl,
        profile,
        config: workflowConfig,
        providerEntries: providerSnapshot.entries,
      })
        .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
        .finally(() => setLaunchingAction(null));
    },
    [
      client,
      conflictModelSupported,
      providerSnapshot.entries,
      deliveryProfile,
      launchingAction,
      openAgentsSettings,
      reviewProfile,
      serverId,
      t,
      toast,
      workflowConfig,
      workflowContext,
      workspaceId,
    ],
  );
  const workflowNativeAction = [gitActions.primary, ...gitActions.secondary].find(
    (action) => action?.id === workflowState.nativeActionId,
  );
  const viewPrAction = useMemo(
    () =>
      [gitActions.primary, ...gitActions.secondary].find((action) => action?.id === "pr") ?? null,
    [gitActions.primary, gitActions.secondary],
  );
  const workflowDisabled =
    launchingAction !== null ||
    !workflowSupported ||
    workflowState.action === "checking" ||
    workflowState.action === "unavailable" ||
    (workflowNativeAction?.disabled ?? false);

  const workflowLabel = workspaceWorkflowLabel(workflowState);

  const handleReview = useCallback(() => launch("review"), [launch]);
  const handleCommit = useCallback(() => runGitAction(commitAction), [runGitAction, commitAction]);
  const handlePr = useCallback(() => {
    const action = workflowState.action;
    if (
      action === "create-pr" ||
      action === "commit-and-push" ||
      action === "resolve-conflicts" ||
      action === "repair-checks"
    ) {
      launch(action);
      return;
    }
    if (workflowNativeAction) runGitAction(workflowNativeAction);
  }, [launch, workflowState.action, workflowNativeAction, runGitAction]);
  const handleViewPr = useCallback(() => {
    if (viewPrAction) runGitAction(viewPrAction);
  }, [runGitAction, viewPrAction]);

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        leftIcon={reviewIcon}
        textStyle={styles.reviewText}
        testID="workspace-git-review"
        accessibilityLabel="Review"
        disabled={!workflowSupported || launchingAction !== null}
        loading={launchingAction === "review"}
        onPress={handleReview}
      >
        {hideLabels ? null : "Review"}
      </Button>
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <Button
            size="xs"
            variant="ghost"
            leftIcon={GitCommitHorizontal}
            testID="workspace-git-commit"
            accessibilityLabel="Commit"
            disabled={commitAction.disabled}
            loading={commitAction.status === "pending"}
            onPress={handleCommit}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>Commit</Text>
        </TooltipContent>
      </Tooltip>
      {viewPrAction && workflowState.action !== "view-pr" ? (
        <Button
          size="xs"
          variant="secondary"
          testID="workspace-git-view-pr"
          disabled={!viewPrAction || viewPrAction.disabled}
          loading={viewPrAction?.status === "pending"}
          onPress={handleViewPr}
        >
          {t("workspace.git.actions.viewPr")}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant={workflowButtonVariant(workflowState.action)}
        leftIcon={GitPullRequest}
        style={
          workflowState.action === "resolve-conflicts" ||
          workflowState.action === "merge" ||
          workflowState.action === "archive"
            ? undefined
            : styles.prButton
        }
        testID="changes-primary-cta"
        accessibilityLabel={workflowLabel}
        disabled={workflowDisabled}
        loading={
          launchingAction === workflowState.action || workflowNativeAction?.status === "pending"
        }
        onPress={handlePr}
      >
        {hideLabels ? null : workflowLabel}
      </Button>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  reviewText: { color: theme.colors.workspace.review },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  prButton: { backgroundColor: theme.colors.surface0, borderColor: theme.colors.workspace.border },
}));
