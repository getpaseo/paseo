import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { useAgentProfiles } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useStableEvent } from "@/hooks/use-stable-event";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { createPluginAgentActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { PlanActionState, resolvePlanActions, type PlanAction } from "./model";
import { runPlanContribution } from "./contribution";

function planActionTestId(id: string): string {
  if (id === "approve") return "permission-request-accept";
  if (id === "deny") return "permission-request-deny";
  return `plan-action-${id}`;
}

function PlanActionControl({
  action,
  label,
  busy,
  disabled,
  compact,
  run,
}: {
  action: PlanAction;
  label: string;
  busy: boolean;
  disabled: boolean;
  compact: boolean;
  run: (id: string) => void;
}) {
  const onPress = useCallback(() => run(action.id), [run, action.id]);
  if (action.overflow)
    return (
      <DropdownMenuItem
        onSelect={onPress}
        disabled={disabled}
        status={busy ? "pending" : "idle"}
        description={action.disabledReason}
        testID={`plan-action-${action.id}`}
      >
        {label}
      </DropdownMenuItem>
    );
  return (
    <Button
      size={compact ? "md" : "sm"}
      variant={action.id === "approve" ? "default" : "outline"}
      onPress={onPress}
      loading={busy}
      disabled={disabled}
      aria-busy={busy}
      accessibilityLabel={label}
      testID={planActionTestId(action.id)}
    >
      <Text numberOfLines={1}>{label}</Text>
    </Button>
  );
}

function ProfileButton({
  actionId,
  profile,
  busy,
  disabled,
  compact,
  run,
}: {
  actionId: string;
  profile: { id: string; name: string };
  busy: boolean;
  disabled: boolean;
  compact: boolean;
  run: (actionId: string, profileId: string) => void;
}) {
  const onPress = useCallback(() => run(actionId, profile.id), [run, actionId, profile.id]);
  return (
    <Button
      size={compact ? "md" : "sm"}
      variant="secondary"
      onPress={onPress}
      loading={busy}
      disabled={disabled}
      aria-busy={busy}
      accessibilityLabel={profile.name}
      testID={`plan-handoff-profile-${profile.id}`}
    >
      <Text numberOfLines={1}>{profile.name}</Text>
    </Button>
  );
}

export function PlanActions({
  serverId,
  workspaceId,
  agentId,
  plan,
  permissions,
  readOnly,
}: {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  plan: { callId: string; text: string; turnId?: string; resolved?: boolean };
  permissions: readonly AgentPermissionRequest[];
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const host = useHostRuntimeSnapshot(serverId);
  const { profiles } = useAgentProfiles(serverId);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const supportsStructuredPlans = useHostFeature(serverId, "structuredPlanApproval");
  const installed = useInstalledPlugins();
  const source = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const getAgent = useCallback(() => source.getAgent(agentId), [source, agentId]);
  const agent = useSyncExternalStore(source.subscribe, getAgent, getAgent);
  const [model] = useState(() => new PlanActionState(plan.callId));
  const [lifetime] = useState(() => new AbortController());
  const availability = useRef(new WeakMap<object, Set<string>>());
  useEffect(() => () => lifetime.abort(), [lifetime]);
  model.setPlan(plan.callId);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const contributions = useMemo(
    () =>
      installed
        .filter((plugin) => plugin.serverId === serverId && !plugin.lifetime.signal.aborted)
        .flatMap((plugin) =>
          plugin.planActions.map((contribution) => ({ pluginId: plugin.id, contribution })),
        ),
    [installed, serverId],
  );
  const actions = resolvePlanActions({
    callId: plan.callId,
    launchProfileId: agent?.launchProfileId,
    permissions,
    contributions,
    live: host?.connectionStatus === "online" && host.agentDirectoryStatus === "ready",
    readOnly,
    resolved: plan.resolved,
    fallbackAvailable: supportsStructuredPlans && Boolean(workspaceId) && agent?.status === "idle",
    compact,
  });
  useEffect(() => {
    for (const action of actions) {
      const contribution = action.contribution;
      const callback = contribution?.onAvailable;
      if (!contribution || !callback || action.disabled) continue;
      const calls = availability.current.get(contribution) ?? new Set<string>();
      if (calls.has(plan.callId)) continue;
      const plugin = installed.find(
        (entry) => entry.serverId === serverId && entry.id === action.pluginId,
      );
      if (!plugin || !workspaceId) continue;
      const context = createPluginAgentActionContext({
        plugin,
        state: source,
        workspaceId,
        agentId,
        navigation: createPluginNavigation({ serverId, workspaceId }),
      });
      if (!context) continue;
      calls.add(plan.callId);
      availability.current.set(contribution, calls);
      void (async () => {
        try {
          await callback({
            signal: lifetime.signal,
            ...context,
            plan: {
              callId: plan.callId,
              text: plan.text,
              turnId: plan.turnId,
              permissionRequestId: action.permission?.id,
            },
          });
        } catch {
          // Availability is opportunistic; the action remains available for an explicit retry.
        }
      })();
    }
  }, [
    actions,
    agentId,
    installed,
    lifetime,
    plan.callId,
    plan.text,
    plan.turnId,
    serverId,
    source,
    workspaceId,
  ]);
  const run = useStableEvent((id: string, profileId?: string) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action || action.disabled || (id !== "copy" && model.getSnapshot().pending)) return;
    if (action.contribution?.requiresAgentProfile && !profileId) return;
    if (profileId) setPendingProfileId(profileId);
    void model.run(id, async () => {
      if (id === "copy") {
        await writeMarkdownToRichClipboard(plan.text, getDefaultMarkdownClipboardEnvironment());
        return;
      }
      const liveHost = getHostRuntimeStore().getSnapshot(serverId);
      const client = liveHost?.client;
      if (
        !client ||
        liveHost.connectionStatus !== "online" ||
        liveHost.agentDirectoryStatus !== "ready"
      ) {
        throw new Error(t("common.errors.daemonClientDisconnected"));
      }
      if (!workspaceId) throw new Error("Open the current plan in its workspace.");
      const permission =
        action.permission ??
        (await client.ensurePlanPermission({ agentId, workspaceId, callId: plan.callId }));
      if (id === "approve" || id === "deny") {
        const behavior = id === "approve" ? "allow" : "deny";
        const nativeAction =
          permission.actions?.find(
            (entry) => entry.behavior === behavior && entry.variant === "primary",
          ) ?? permission.actions?.find((entry) => entry.behavior === behavior);
        await client.respondToPermissionAndWait(
          agentId,
          permission.id,
          {
            behavior,
            selectedActionId: nativeAction?.id ?? "accept",
          },
          15000,
        );
        return;
      }
      const plugin = installed.find(
        (entry) => entry.serverId === serverId && entry.id === action.pluginId,
      );
      if (!plugin || !workspaceId || !action.contribution)
        throw new Error(t("common.errors.daemonUnavailable"));
      await runPlanContribution({
        client,
        plugin,
        contributionId: action.contribution.id,
        serverId,
        workspaceId,
        agentId,
        navigation: createPluginNavigation({ serverId, workspaceId }),
        signal: lifetime.signal,
        profileId,
        plan: { ...plan, permissionRequestId: permission.id },
      });
    });
  });
  const label = (action: PlanAction) =>
    action.title ??
    (action.id === "copy"
      ? t(state.copied ? "common.states.copied" : "common.actions.copy")
      : t("agentStream.permission.approve"));
  const busy = (action: PlanAction) =>
    action.id === "copy" ? state.copying : state.pending === action.id;
  const disabled = (action: PlanAction) =>
    Boolean(action.disabled) || (action.id === "copy" ? state.copying : state.pending !== null);
  const profileActions = actions.filter((action) => action.contribution?.requiresAgentProfile);
  const overflow = actions.filter((action) => action.overflow);
  const status =
    [...new Set([state.error, state.copyError].filter(Boolean))].join(" · ") ||
    actions
      .filter((action) => action.disabledReason)
      .map((action) => action.disabledReason)
      .join(" · ");
  const pendingLabel = actions.find((action) => action.id === state.pending)?.title;
  return (
    <View testID="plan-actions" style={styles.container}>
      <View style={styles.bar}>
        {overflow.length > 0 ? (
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={t("workspace.git.actions.moreActions")}
              style={styles.more}
            >
              <Text style={styles.moreLabel}>{t("workspace.git.actions.moreActions")}</Text>
            </DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle={t("agentStream.permission.plan")} align="end">
              {overflow.map((action) => (
                <PlanActionControl
                  key={action.id}
                  action={action}
                  label={label(action)}
                  busy={busy(action)}
                  disabled={disabled(action)}
                  compact={compact}
                  run={run}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {actions
          .filter((action) => !action.overflow && !action.contribution?.requiresAgentProfile)
          .map((action) => (
            <PlanActionControl
              key={action.id}
              action={action}
              label={label(action)}
              busy={busy(action)}
              disabled={disabled(action)}
              compact={compact}
              run={run}
            />
          ))}
      </View>
      {profileActions.map((action) => (
        <View key={action.id} testID="plan-handoff-profiles" style={styles.profiles}>
          <Text style={styles.profileLabel}>{action.title} :</Text>
          {profiles?.length ? (
            profiles.map((profile) => (
              <ProfileButton
                key={profile.id}
                actionId={action.id}
                profile={profile}
                compact={compact}
                run={run}
                busy={state.pending === action.id && pendingProfileId === profile.id}
                disabled={disabled(action)}
              />
            ))
          ) : (
            <Text style={styles.profileLabel}>
              {profiles ? t("workspace.git.workflow.noProfiles") : t("common.states.loading")}
            </Text>
          )}
        </View>
      ))}
      <Text
        accessibilityRole={state.error || state.copyError ? "alert" : undefined}
        accessibilityLiveRegion="polite"
        testID="plan-action-status"
        style={[styles.status, (state.error || state.copyError) && styles.error]}
      >
        {status ||
          (state.pending
            ? `${pendingLabel ?? t("agentStream.permission.approve")} · ${t("common.states.loading")}`
            : " ")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  return {
    container: { minWidth: 0, gap: theme.spacing[2] },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: theme.spacing[2],
      minWidth: 0,
    },
    profiles: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: theme.spacing[2],
      minWidth: 0,
    },
    profileLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
    more: {
      minHeight: 44,
      paddingHorizontal: theme.spacing[3],
      justifyContent: "center",
      borderRadius: theme.borderRadius.lg,
    },
    moreLabel: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
    status: {
      minHeight: 20,
      fontSize: theme.fontSize.sm,
      lineHeight: 20,
      color: theme.colors.foregroundMuted,
    },
    error: { color: theme.colors.statusDanger },
  };
});
