import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Terminal, Blocks, Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { useCliInstall, useSkillsInstall } from "@/desktop/hooks/use-install-status";

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

export function IntegrationsSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const {
    status: cliStatus,
    isInstalling: isInstallingCli,
    install: installCli,
    refresh: refreshCliStatus,
  } = useCliInstall();
  const {
    status: skillsStatus,
    isInstalling: isInstallingSkills,
    install: installSkills,
    refresh: refreshSkillsStatus,
  } = useSkillsInstall();

  useFocusEffect(
    useCallback(() => {
      if (!showSection) return undefined;
      refreshCliStatus();
      refreshSkillsStatus();
      return undefined;
    }, [refreshCliStatus, refreshSkillsStatus, showSection]),
  );

  const handleInstallCli = useCallback(() => {
    if (isInstallingCli) return;
    installCli();
  }, [installCli, isInstallingCli]);

  const handleInstallSkills = useCallback(() => {
    if (isInstallingSkills) return;
    installSkills();
  }, [installSkills, isInstallingSkills]);

  const handleOpenCliDocs = useCallback(() => {
    void openExternalUrl(CLI_DOCS_URL);
  }, []);

  const handleOpenSkillsDocs = useCallback(() => {
    void openExternalUrl(SKILLS_DOCS_URL);
  }, []);

  const arrowIcon = useMemo(
    () => <ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );

  const trailing = useMemo(
    () => (
      <View style={styles.headerLinks}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={arrowIcon}
          textStyle={settingsStyles.sectionHeaderLinkText}
          style={settingsStyles.sectionHeaderLink}
          onPress={handleOpenCliDocs}
          accessibilityLabel="Open CLI documentation"
        >
          CLI docs
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={arrowIcon}
          textStyle={settingsStyles.sectionHeaderLinkText}
          style={settingsStyles.sectionHeaderLink}
          onPress={handleOpenSkillsDocs}
          accessibilityLabel="Open skills documentation"
        >
          Skills docs
        </Button>
      </View>
    ),
    [arrowIcon, handleOpenCliDocs, handleOpenSkillsDocs],
  );

  if (!showSection) {
    return null;
  }

  return (
    <SettingsSection title="Integrations" trailing={trailing}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Terminal size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>Command line</Text>
            </View>
            <Text style={settingsStyles.rowHint}>Control and script agents from your terminal</Text>
          </View>
          {cliStatus?.installed ? (
            <View style={styles.installedLabel}>
              <Check size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.mutedText}>Installed</Text>
            </View>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={handleInstallCli}
              disabled={isInstallingCli}
            >
              {isInstallingCli ? "Installing..." : "Install"}
            </Button>
          )}
        </View>
        <View style={ROW_WITH_BORDER_STYLE}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Blocks size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>Orchestration skills</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              Teach your agents to orchestrate through the CLI
            </Text>
          </View>
          {skillsStatus?.installed ? (
            <View style={styles.installedLabel}>
              <Check size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.mutedText}>Installed</Text>
            </View>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={handleInstallSkills}
              disabled={isInstallingSkills}
            >
              {isInstallingSkills ? "Installing..." : "Install"}
            </Button>
          )}
        </View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerLinks: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0],
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  installedLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
