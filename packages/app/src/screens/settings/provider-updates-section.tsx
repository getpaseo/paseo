import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { ProviderCli } from "@/hooks/use-provider-cli";
import { settingsStyles } from "@/styles/settings";

interface ProviderUpdatesSectionProps {
  serverId: string;
  cli: ProviderCli;
  labelFor: (provider: string) => string;
}

// Host-wide, persisted, and applied live by the daemon.
export function ProviderUpdatesSection({ serverId, cli, labelFor }: ProviderUpdatesSectionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const autoUpdateMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({ autoUpdateProviders: next });
      if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      return result;
    },
  });

  const managed = useMemo(
    () => cli.statuses.filter((status) => status.installed && !status.managedExternally),
    [cli.statuses],
  );
  const outdated = useMemo(
    () => managed.filter((status) => status.updateAvailable && status.update.supported),
    [managed],
  );
  const isUpdating = managed.some((status) => status.update.status === "running");
  const hasCheckedAll = managed.length > 0 && managed.every((status) => status.latestVersion);

  const handleAutoUpdateChange = useCallback(
    (next: boolean) => autoUpdateMutation.mutate(next),
    [autoUpdateMutation],
  );

  const handleCheck = useCallback(() => {
    void cli
      .checkForUpdates()
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  }, [cli, toast]);

  const handleUpdateAll = useCallback(() => {
    for (const status of outdated) {
      void cli
        .update(status.provider)
        .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
    }
  }, [cli, outdated, toast]);

  if (!cli.isSupported || !config || managed.length === 0) return null;

  let checkHint: string;
  if (cli.isChecking) {
    checkHint = t("settings.providers.cli.checking");
  } else if (isUpdating) {
    checkHint = t("settings.providers.cli.updating");
  } else if (outdated.length > 0) {
    checkHint = t("settings.providers.cli.updatesAvailableFor", {
      names: outdated.map((status) => labelFor(status.provider)).join(", "),
    });
  } else if (hasCheckedAll) {
    checkHint = t("settings.providers.cli.allUpToDate");
  } else {
    checkHint = t("settings.providers.cli.latestUnavailable");
  }

  return (
    <SettingsSection
      title={t("settings.providers.cli.updatesTitle")}
      info={t("settings.providers.cli.updatesInfo")}
      testID="host-page-provider-updates-card"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.providers.cli.autoUpdate")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.providers.cli.autoUpdateHint")}</Text>
            {autoUpdateMutation.error ? (
              <Text style={settingsStyles.rowError}>{autoUpdateMutation.error.message}</Text>
            ) : null}
          </View>
          <Switch
            value={config.autoUpdateProviders === true}
            onValueChange={handleAutoUpdateChange}
            disabled={autoUpdateMutation.isPending}
            accessibilityLabel={t("settings.providers.cli.autoUpdate")}
            testID="provider-updates-auto-switch"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.providers.cli.checkTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{checkHint}</Text>
          </View>
          {outdated.length > 0 || isUpdating ? (
            <Button
              variant="outline"
              onPress={handleUpdateAll}
              disabled={isUpdating}
              loading={isUpdating}
              testID="provider-updates-update-all"
            >
              {isUpdating
                ? t("settings.providers.cli.updating")
                : t("settings.providers.cli.updateAll")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onPress={handleCheck}
              disabled={cli.isChecking}
              loading={cli.isChecking}
              testID="provider-updates-check"
            >
              {t("settings.providers.cli.checkNow")}
            </Button>
          )}
        </View>
      </View>
    </SettingsSection>
  );
}
