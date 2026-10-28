import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

// COMPAT(restartRecovery): added in v0.14.0, remove gate after 2027-04-28.
export function RestartRecoveryCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "resumeOnStartupSetting");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [prompt, setPrompt] = useState<string | undefined>();
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

  const commitPrompt = useCallback(() => {
    if (prompt !== undefined) mutation.mutate({ resumePrompt: prompt });
  }, [prompt, mutation]);

  if (!isConnected || !isSupported || !config) return null;

  return (
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
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="host-page-restart-recovery-error">
              {mutation.error.message}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config.resumeOnStartup !== false}
          onValueChange={handleValueChange}
          disabled={mutation.isPending}
          accessibilityLabel={t("settings.host.agents.resumeOnStartup.title")}
          testID="host-page-restart-recovery-switch"
        />
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Field label={t("settings.host.agents.resumeOnStartup.prompt")}>
            <FormTextInput
              initialValue={config.resumePrompt ?? "Resume working."}
              onChangeText={setPrompt}
              onBlur={commitPrompt}
              accessibilityLabel={t("settings.host.agents.resumeOnStartup.prompt")}
              multiline
            />
          </Field>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
