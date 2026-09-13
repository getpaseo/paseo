import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useStableEvent } from "@/hooks/use-stable-event";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { createPluginAgentActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { PlanActionState, resolvePlanActions, type PlanAction } from "./model";

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
      testID={action.id === "approve" ? "permission-request-accept" : `plan-action-${action.id}`}
    >
      <Text numberOfLines={1}>{label}</Text>
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
  plan: { callId: string; text: string; turnId?: string };
  permissions: readonly AgentPermissionRequest[];
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const host = useHostRuntimeSnapshot(serverId);
  const installed = useInstalledPlugins();
  const source = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const getAgent = useCallback(() => source.getAgent(agentId), [source, agentId]);
  const agent = useSyncExternalStore(source.subscribe, getAgent, getAgent);
  const [model] = useState(() => new PlanActionState(plan.callId));
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
    compact,
  });
  const run = useStableEvent((id: string) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action || action.disabled) return;
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
      const permission = action.permission;
      if (!permission) return;
      if (id === "approve") {
        const nativeAction =
          permission.actions?.find(
            (entry) => entry.behavior === "allow" && entry.variant === "primary",
          ) ?? permission.actions?.find((entry) => entry.behavior === "allow");
        await client.respondToPermissionAndWait(
          agentId,
          permission.id,
          {
            behavior: "allow",
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
      const runtime = createPluginSurfaceRuntime(client, plugin);
      if (!runtime) throw new Error(t("common.errors.daemonUnavailable"));
      try {
        const context = createPluginAgentActionContext({
          plugin,
          runtime,
          state: source,
          workspaceId,
          agentId,
          navigation: createPluginNavigation({ serverId, workspaceId }),
        });
        if (!context) throw new Error(t("common.errors.daemonUnavailable"));
        await action.contribution.onPress({
          ...context,
          plan: { ...plan, permissionRequestId: permission.id },
        });
      } finally {
        await runtime.paseo.dispose();
      }
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
          .filter((action) => !action.overflow)
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

const styles = StyleSheet.create((theme) => ({
  container: { minWidth: 0, gap: theme.spacing[2] },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    minWidth: 0,
  },
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
}));
