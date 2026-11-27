import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsInfoTip, SettingsRow } from "@/components/settings";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Host-wide, persisted, and applied live by the daemon.
export function IdleRuntimeCleanupRow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "idleRuntimeCleanupSetting");
  // COMPAT(idleRuntimeCleanupHook): added in v0.18.0, remove gate after 2027-05-27.
  const supportsHook = useHostFeature(serverId, "idleRuntimeCleanupHook");
  // COMPAT(forceIdleRuntimeCleanup): added in v0.18.0, remove gate after 2027-05-27.
  const supportsForce = useHostFeature(serverId, "forceIdleRuntimeCleanup");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [isEditing, setIsEditing] = useState(false);
  const mutation = useMutation({
    mutationFn: async (next: MutableDaemonConfigPatch) => {
      const result = await patchConfig(next);
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ idleRuntimeCleanup: next });
    },
    [mutation],
  );

  const handleForceChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ forceIdleRuntimeCleanup: next });
    },
    [mutation],
  );

  const openHook = useCallback(() => {
    mutation.reset();
    setIsEditing(true);
  }, [mutation]);

  const closeHook = useCallback(() => {
    if (mutation.isPending) return;
    mutation.reset();
    setIsEditing(false);
  }, [mutation]);

  const saveHook = useCallback(
    (script: string) => {
      mutation.mutate({ idleRuntimeCleanupHook: script }, { onSuccess: () => setIsEditing(false) });
    },
    [mutation],
  );

  const infoTip = useMemo(
    () => (
      <SettingsInfoTip
        title={t("settings.host.agents.idleRuntimeCleanup.title")}
        info={t("settings.host.agents.idleRuntimeCleanup.info")}
      />
    ),
    [t],
  );

  if (!isConnected || !isSupported || !config) return null;

  const enabled = config.idleRuntimeCleanup !== false;
  const script = config.idleRuntimeCleanupHook ?? "";
  const forceError = mutation.variables?.forceIdleRuntimeCleanup !== undefined;
  const error = mutation.error?.message;
  const forceLabel = t("settings.host.agents.idleRuntimeCleanup.forceTitle");

  return (
    <>
      <SettingsRow
        label={t("settings.host.agents.idleRuntimeCleanup.title")}
        labelAccessory={infoTip}
        hint={t("settings.host.agents.idleRuntimeCleanup.hint")}
        error={isEditing || forceError ? undefined : error}
        errorTestID="host-page-idle-runtime-cleanup-error"
        testID="host-page-idle-runtime-cleanup-card"
      >
        <Switch
          value={enabled}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel={t("settings.host.agents.idleRuntimeCleanup.title")}
          testID="host-page-idle-runtime-cleanup-switch"
        />
      </SettingsRow>
      {enabled && supportsForce ? (
        <SettingsRow
          label={forceLabel}
          hint={t("settings.host.agents.idleRuntimeCleanup.forceHint")}
          error={forceError ? error : undefined}
        >
          <Switch
            value={config.forceIdleRuntimeCleanup === true}
            onValueChange={handleForceChange}
            disabled={mutation.isPending}
            accessibilityLabel={forceLabel}
          />
        </SettingsRow>
      ) : null}
      {enabled && supportsHook ? (
        <>
          <SettingsRow
            label={t("settings.host.agents.idleRuntimeCleanup.hook")}
            hint={t("settings.host.agents.idleRuntimeCleanup.hookHint")}
          >
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onPress={openHook}
              accessibilityLabel={t("settings.host.agents.idleRuntimeCleanup.hook")}
            >
              {script.trim()
                ? t("settings.host.agents.resumeOnStartup.edit")
                : t("settings.host.agents.idleRuntimeCleanup.hookAdd")}
            </Button>
          </SettingsRow>
          {isEditing ? (
            <IdleReleaseHookSheet
              key={serverId}
              script={script}
              error={mutation.error?.message}
              isSaving={mutation.isPending}
              onClose={closeHook}
              onSave={saveHook}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function IdleReleaseHookSheet({
  script,
  error,
  isSaving,
  onClose,
  onSave,
}: {
  script: string;
  error?: string;
  isSaving: boolean;
  onClose: () => void;
  onSave: (script: string) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [draft, setDraft] = useState(script);
  const title = t("settings.host.agents.idleRuntimeCleanup.hook");
  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
  const handleSave = useCallback(() => onSave(draft), [draft, onSave]);

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} desktopMaxWidth={560}>
      <Text style={settingsStyles.rowHint}>
        {t("settings.host.agents.idleRuntimeCleanup.hookHelp")}
      </Text>
      <FormTextInput
        size={isCompact ? "md" : "sm"}
        accessibilityLabel={title}
        initialValue={script}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        editable={!isSaving}
        style={styles.script}
      />
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      <View style={styles.sheetActions}>
        <Button variant="ghost" onPress={onClose} disabled={isSaving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          loading={isSaving}
          disabled={draft === script || isSaving}
          onPress={handleSave}
        >
          {t("common.actions.save")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  script: {
    minHeight: 96,
    fontFamily: theme.fontFamily.mono,
  },
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
