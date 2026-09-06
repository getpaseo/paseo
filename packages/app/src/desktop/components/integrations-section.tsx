import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Check, Terminal } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";

export function IntegrationsSection() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const { status, isInstalling, install, refresh } = useCliInstall();
  useFocusEffect(
    useCallback(() => {
      if (showSection) refresh();
      return undefined;
    }, [refresh, showSection]),
  );
  const docsIcon = useMemo(
    () => <ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );
  const handleOpenDocs = useCallback(() => {
    void openExternalUrl(CLI_DOCS_URL);
  }, []);
  const trailing = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={docsIcon}
        textStyle={settingsStyles.sectionHeaderLinkText}
        style={settingsStyles.sectionHeaderLink}
        onPress={handleOpenDocs}
        accessibilityLabel={t("settings.integrations.docs.openCli")}
      >
        {t("settings.integrations.docs.cli")}
      </Button>
    ),
    [docsIcon, handleOpenDocs, t],
  );
  if (!showSection) return null;
  return (
    <SettingsSection title={t("settings.integrations.title")} trailing={trailing}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Terminal size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>
                {t("settings.integrations.commandLine.title")}
              </Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {t("settings.integrations.commandLine.description")}
            </Text>
          </View>
          {status?.installed ? (
            <View style={styles.installedLabel}>
              <Check size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.mutedText}>{t("settings.integrations.actions.installed")}</Text>
            </View>
          ) : (
            <Button variant="outline" size="sm" onPress={install} disabled={isInstalling}>
              {isInstalling
                ? t("settings.integrations.actions.installing")
                : t("settings.integrations.actions.install")}
            </Button>
          )}
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  installedLabel: { flexDirection: "row", alignItems: "center", gap: 4 },
  mutedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
