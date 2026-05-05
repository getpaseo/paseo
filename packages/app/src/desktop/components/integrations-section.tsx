import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Terminal, Blocks, Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  shouldUseDesktopDaemon,
  getCliInstallStatus,
  installCli,
  getSkillsInstallStatus,
  installSkills,
  type InstallStatus,
} from "@/desktop/daemon/desktop-daemon";
import { useDesktopMutation, useDesktopQuery } from "@/desktop/hooks/use-desktop-ipc";

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];
const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "integrations", "cli-install-status"] as const;
const SKILLS_INSTALL_STATUS_QUERY_KEY = [
  "desktop",
  "integrations",
  "skills-install-status",
] as const;

export function IntegrationsSection() {
  const { theme } = useUnistyles();
  const queryClient = useQueryClient();
  const showSection = shouldUseDesktopDaemon();

  const { data: cliStatus, refetch: refetchCliStatus } = useDesktopQuery({
    queryKey: CLI_INSTALL_STATUS_QUERY_KEY,
    queryFn: getCliInstallStatus,
    enabled: showSection,
    errorMessage: "Unable to check CLI install status.",
    logLabel: "[Integrations] Failed to load CLI status",
  });
  const { data: skillsStatus, refetch: refetchSkillsStatus } = useDesktopQuery({
    queryKey: SKILLS_INSTALL_STATUS_QUERY_KEY,
    queryFn: getSkillsInstallStatus,
    enabled: showSection,
    errorMessage: "Unable to check orchestration skills install status.",
    logLabel: "[Integrations] Failed to load skills status",
  });

  const { mutate: runCliInstall, isPending: isInstallingCli } = useDesktopMutation<InstallStatus>({
    mutationFn: installCli,
    errorMessage: "Unable to install the Paseo CLI.",
    logLabel: "[Integrations] Failed to install CLI",
    onSuccess: (status) => {
      queryClient.setQueryData<InstallStatus>(CLI_INSTALL_STATUS_QUERY_KEY, status);
    },
  });
  const { mutate: runSkillsInstall, isPending: isInstallingSkills } =
    useDesktopMutation<InstallStatus>({
      mutationFn: installSkills,
      errorMessage: "Unable to install orchestration skills.",
      logLabel: "[Integrations] Failed to install skills",
      onSuccess: (status) => {
        queryClient.setQueryData<InstallStatus>(SKILLS_INSTALL_STATUS_QUERY_KEY, status);
      },
    });

  useFocusEffect(
    useCallback(() => {
      if (!showSection) return undefined;
      void refetchCliStatus();
      void refetchSkillsStatus();
      return undefined;
    }, [refetchCliStatus, refetchSkillsStatus, showSection]),
  );

  const handleInstallCli = useCallback(() => {
    if (isInstallingCli) return;
    runCliInstall();
  }, [isInstallingCli, runCliInstall]);

  const handleInstallSkills = useCallback(() => {
    if (isInstallingSkills) return;
    runSkillsInstall();
  }, [isInstallingSkills, runSkillsInstall]);

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
