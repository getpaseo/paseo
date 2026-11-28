import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { SettingsCollapsibleRow, SettingsRow } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import {
  AGENT_TOOL_GROUP_ORDER,
  createAgentToolGroupPatch,
  createAgentToolsMasterPatch,
  resolveAgentToolsState,
  type AgentToolGroupId,
  type AgentToolGroupsState,
} from "./agent-tools-config";

const GROUP_TRANSLATION_KEYS: Record<
  AgentToolGroupId,
  {
    title:
      | "settings.host.tools.groups.orchestration.title"
      | "settings.host.tools.groups.schedules.title"
      | "settings.host.tools.groups.changeRequests.title"
      | "settings.host.tools.groups.browser.title";
    hint:
      | "settings.host.tools.groups.orchestration.hint"
      | "settings.host.tools.groups.schedules.hint"
      | "settings.host.tools.groups.changeRequests.hint"
      | "settings.host.tools.groups.browser.hint";
  }
> = {
  orchestration: {
    title: "settings.host.tools.groups.orchestration.title",
    hint: "settings.host.tools.groups.orchestration.hint",
  },
  schedules: {
    title: "settings.host.tools.groups.schedules.title",
    hint: "settings.host.tools.groups.schedules.hint",
  },
  changeRequests: {
    title: "settings.host.tools.groups.changeRequests.title",
    hint: "settings.host.tools.groups.changeRequests.hint",
  },
  browser: {
    title: "settings.host.tools.groups.browser.title",
    hint: "settings.host.tools.groups.browser.hint",
  },
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveHintStatus(
  error: string | null | undefined,
  isPending: boolean | undefined,
): "error" | "busy" | undefined {
  if (error) return "error";
  if (isPending) return "busy";
  return undefined;
}

/** The host's expandable "Enable tools" row, bound to the host's config, for composing inside a SettingsCard. */
export function HostAgentToolsRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsToolsConfig = useHostFeature(serverId, "daemonToolsConfig");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const state = useMemo(
    () => resolveAgentToolsState({ config, supportsToolsConfig }),
    [config, supportsToolsConfig],
  );

  const mutation = useMutation({
    mutationFn: async (patch: MutableDaemonConfigPatch) => {
      const result = await patchConfig(patch);
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      mutation.mutate(createAgentToolsMasterPatch({ enabled, supportsToolsConfig }));
    },
    [mutation, supportsToolsConfig],
  );

  const handleGroupChange = useCallback(
    (group: AgentToolGroupId, enabled: boolean) => {
      const patch = createAgentToolGroupPatch({ group, enabled, supportsToolsConfig });
      if (!patch) return;
      mutation.mutate(patch);
    },
    [mutation, supportsToolsConfig],
  );

  if (!isConnected) return null;

  return (
    <AgentToolsRow
      enabled={state.enabled}
      groups={state.groups}
      supportsGroupControls={state.supportsGroupControls}
      onEnabledChange={handleEnabledChange}
      onGroupChange={handleGroupChange}
      isPending={mutation.isPending}
      error={mutation.error ? toErrorMessage(mutation.error) : null}
    />
  );
}

/** Plain "Enable tools" switch with no group controls, for setup. Groups stay in Settings. */
export function EnableToolsSwitchRow({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("settings.host.orchestration.enableTools.title")}
      hint={t("settings.host.orchestration.enableTools.hint")}
    >
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
      />
    </SettingsRow>
  );
}

/** Expandable "Enable tools" row on its own, for callers that control the state. */
export function AgentToolsRow({
  enabled,
  groups,
  supportsGroupControls,
  onEnabledChange,
  onGroupChange,
  disabled,
  isPending,
  error,
}: {
  enabled: boolean;
  groups: AgentToolGroupsState;
  supportsGroupControls: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onGroupChange: (group: AgentToolGroupId, enabled: boolean) => void;
  disabled?: boolean;
  isPending?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation();
  const visibleGroups: readonly AgentToolGroupId[] = supportsGroupControls
    ? AGENT_TOOL_GROUP_ORDER
    : ["browser"];
  const controlsDisabled = Boolean(disabled || isPending);
  const hint = error ?? t("settings.host.orchestration.enableTools.hint");
  const hintStatus = resolveHintStatus(error, isPending);

  const masterControl = useMemo(
    () => (
      <Switch
        value={enabled}
        onValueChange={onEnabledChange}
        disabled={controlsDisabled}
        accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
        testID="host-page-tools-master-switch"
      />
    ),
    [controlsDisabled, enabled, onEnabledChange, t],
  );

  return (
    <SettingsCollapsibleRow
      label={t("settings.host.orchestration.enableTools.title")}
      hint={hint}
      hintStatus={hintStatus}
      control={masterControl}
      testID="host-page-tools-row"
    >
      {visibleGroups.map((group) => (
        <ToolGroupSwitchRow
          key={group}
          group={group}
          value={groups[group]}
          disabled={controlsDisabled || !enabled}
          dimmed={!enabled}
          onGroupChange={onGroupChange}
        />
      ))}
      <View style={styles.noteRow}>
        <Text style={settingsStyles.rowHint}>
          {supportsGroupControls
            ? t("settings.host.tools.pluginNote")
            : t("settings.host.tools.updateHostForGroups")}
        </Text>
      </View>
    </SettingsCollapsibleRow>
  );
}

function ToolGroupSwitchRow({
  group,
  value,
  disabled,
  dimmed,
  onGroupChange,
}: {
  group: AgentToolGroupId;
  value: boolean;
  disabled: boolean;
  dimmed: boolean;
  onGroupChange: (group: AgentToolGroupId, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const keys = GROUP_TRANSLATION_KEYS[group];
  const label = t(keys.title);
  const handleChange = useCallback(
    (next: boolean) => {
      onGroupChange(group, next);
    },
    [group, onGroupChange],
  );

  return (
    <View style={dimmed ? styles.disabledGroup : undefined}>
      <SettingsRow
        label={label}
        hint={t(keys.hint)}
        testID={
          group === "browser" ? "host-page-browser-tools-card" : `host-page-tool-group-${group}`
        }
      >
        <Switch
          value={value}
          onValueChange={handleChange}
          disabled={disabled}
          accessibilityLabel={label}
          testID={
            group === "browser"
              ? "host-page-browser-tools-switch"
              : `host-page-tool-group-${group}-switch`
          }
        />
      </SettingsRow>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  disabledGroup: {
    opacity: theme.opacity[50],
  },
  noteRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
}));
