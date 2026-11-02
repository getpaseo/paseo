import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

const DEFAULT_RESUME_PROMPT = "Resume working.";

// COMPAT(restartRecovery): added in v0.14.0, remove gate after 2027-04-28.
export function RestartRecoveryCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "resumeOnStartupSetting");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [isEditing, setIsEditing] = useState(false);
  const mutation = useMutation({
    mutationFn: async (next: { resumeOnStartup?: boolean; resumePrompt?: string }) => {
      const result = await patchConfig(next);
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutation.mutate({ resumeOnStartup: next });
    },
    [mutation],
  );

  const handleOpen = useCallback(() => {
    mutation.reset();
    setIsEditing(true);
  }, [mutation]);

  const handleClose = useCallback(() => {
    if (mutation.isPending) return;
    mutation.reset();
    setIsEditing(false);
  }, [mutation]);

  const handleSave = useCallback(
    (prompt: string) => {
      mutation.mutate({ resumePrompt: prompt }, { onSuccess: () => setIsEditing(false) });
    },
    [mutation],
  );

  if (!isConnected || !isSupported || !config) return null;

  const isEnabled = config.resumeOnStartup !== false;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-restart-recovery-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.titleRow}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.host.agents.resumeOnStartup.title")}
              </Text>
              <SettingsInfoTip
                title={t("settings.host.agents.resumeOnStartup.title")}
                info={t("settings.host.agents.resumeOnStartup.info")}
              />
            </View>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.agents.resumeOnStartup.hint")}
            </Text>
            {mutation.error && !isEditing ? (
              <Text style={settingsStyles.rowError} testID="host-page-restart-recovery-error">
                {mutation.error.message}
              </Text>
            ) : null}
          </View>
          <View style={styles.trailing}>
            <Button
              variant="outline"
              size="sm"
              onPress={handleOpen}
              disabled={!isEnabled || mutation.isPending}
              accessibilityLabel={t("settings.host.agents.resumeOnStartup.editAccessibilityLabel")}
              testID="host-page-restart-recovery-edit"
            >
              {t("settings.host.agents.resumeOnStartup.edit")}
            </Button>
            <Switch
              value={isEnabled}
              onValueChange={handleValueChange}
              disabled={mutation.isPending}
              accessibilityLabel={t("settings.host.agents.resumeOnStartup.title")}
              testID="host-page-restart-recovery-switch"
            />
          </View>
        </View>
      </View>

      {isEditing ? (
        <ResumePromptSheet
          initialPrompt={config.resumePrompt ?? DEFAULT_RESUME_PROMPT}
          isSaving={mutation.isPending}
          error={mutation.error?.message ?? null}
          onSave={handleSave}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

function ResumePromptSheet({
  initialPrompt,
  isSaving,
  error,
  onSave,
  onClose,
}: {
  initialPrompt: string;
  isSaving: boolean;
  error: string | null;
  onSave: (prompt: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialPrompt);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.agents.resumeOnStartup.prompt") }),
    [t],
  );
  const canSave = draft !== initialPrompt && draft.trim().length > 0 && !isSaving;

  const handleSave = useCallback(() => onSave(draft), [draft, onSave]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="host-page-restart-recovery-sheet"
      desktopMaxWidth={560}
    >
      <SettingsTextAreaCard
        testID="host-page-restart-recovery-prompt-input"
        accessibilityLabel={t("settings.host.agents.resumeOnStartup.prompt")}
        value={draft}
        onChangeText={setDraft}
        placeholder={DEFAULT_RESUME_PROMPT}
      />
      {error ? (
        <Text style={settingsStyles.rowError} testID="host-page-restart-recovery-error">
          {error}
        </Text>
      ) : null}
      <View style={styles.sheetActions}>
        <Button variant="ghost" size="sm" onPress={onClose} disabled={isSaving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          disabled={!canSave}
          testID="host-page-restart-recovery-save"
        >
          {t("common.actions.save")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
