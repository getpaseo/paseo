import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import * as Updates from "expo-updates";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { openConfigBackupFile, saveConfigBackupFile } from "@/config-backup/file-io";
import {
  createPaseoConfigBackup,
  parsePaseoConfigBackup,
  restorePaseoConfigBackup,
} from "@/config-backup/portable-config";
import { portableConfigRuntimeDeps } from "@/config-backup/runtime-deps";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

function reloadAfterConfigImport(): void {
  if (isWeb) {
    window.location.reload();
    return;
  }
  void Updates.reloadAsync();
}

export function ConfigBackupSection({
  serverId,
  hostLabel,
}: {
  serverId: string | null;
  hostLabel: string | null;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "portableConfigBackup");
  const [operation, setOperation] = useState<"export" | "import" | null>(null);
  const available = Boolean(serverId && client && supported);

  const handleExport = useCallback(async () => {
    if (!client || !serverId || operation) return;
    setOperation("export");
    try {
      const backup = await createPaseoConfigBackup({
        client,
        sourceHost: { serverId, label: hostLabel ?? serverId },
        deps: portableConfigRuntimeDeps,
      });
      const date = backup.exportedAt.slice(0, 10);
      const saved = await saveConfigBackupFile({
        fileName: `paseo-config-${date}.json`,
        content: `${JSON.stringify(backup, null, 2)}\n`,
      });
      if (saved) {
        Alert.alert(
          t("settings.general.configBackup.successTitle"),
          t("settings.general.configBackup.exportSuccess"),
        );
      }
    } catch (error) {
      Alert.alert(
        t("settings.general.configBackup.errorTitle"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setOperation(null);
    }
  }, [client, hostLabel, operation, serverId, t]);

  const handleImport = useCallback(async () => {
    if (!client || !serverId || operation) return;
    setOperation("import");
    try {
      const selected = await openConfigBackupFile();
      if (!selected) return;
      const backup = parsePaseoConfigBackup(selected.content);
      const confirmed = await confirmDialog({
        title: t("settings.general.configBackup.confirmTitle"),
        message: t("settings.general.configBackup.confirmMessage"),
        confirmLabel: t("settings.general.configBackup.import"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!confirmed) return;
      const result = await restorePaseoConfigBackup({
        backup,
        client,
        targetServerId: serverId,
        deps: portableConfigRuntimeDeps,
      });
      Alert.alert(
        t("settings.general.configBackup.successTitle"),
        t("settings.general.configBackup.importSuccess", {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
        }),
        [{ text: t("common.actions.close"), onPress: reloadAfterConfigImport }],
      );
    } catch (error) {
      Alert.alert(
        t("settings.general.configBackup.errorTitle"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setOperation(null);
    }
  }, [client, operation, serverId, t]);

  return (
    <SettingsSection title={t("settings.general.configBackup.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.configBackup.label")}</Text>
            <Text style={settingsStyles.rowHint}>
              {available
                ? t("settings.general.configBackup.description")
                : t("settings.general.configBackup.unavailable")}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button
              variant="outline"
              size="sm"
              disabled={!available || operation !== null}
              loading={operation === "import"}
              onPress={handleImport}
            >
              {t("settings.general.configBackup.import")}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={!available || operation !== null}
              loading={operation === "export"}
              onPress={handleExport}
            >
              {t("settings.general.configBackup.export")}
            </Button>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
