import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Terminal, Blocks, Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
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

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";

export function IntegrationsSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();

  const [cliStatus, setCliStatus] = useState<InstallStatus | null>(null);
  const [skillsStatus, setSkillsStatus] = useState<InstallStatus | null>(null);
  const [isInstallingCli, setIsInstallingCli] = useState(false);
  const [isInstallingSkills, setIsInstallingSkills] = useState(false);

  const loadStatus = useCallback(() => {
    if (!showSection) return;
    void getCliInstallStatus()
      .then(setCliStatus)
      .catch((error) => {
        console.error("[Integrations] Failed to load CLI status", error);
      });
    void getSkillsInstallStatus()
      .then(setSkillsStatus)
      .catch((error) => {
        console.error("[Integrations] Failed to load skills status", error);
      });
  }, [showSection]);

  useFocusEffect(
    useCallback(() => {
      if (!showSection) return undefined;
      loadStatus();
      return undefined;
    }, [loadStatus, showSection]),
  );

  const handleInstallCli = useCallback(() => {
    if (isInstallingCli) return;
    setIsInstallingCli(true);
    void installCli()
      .then(setCliStatus)
      .catch((error) => {
        console.error("[Integrations] Failed to install CLI", error);
      })
      .finally(() => {
        setIsInstallingCli(false);
      });
  }, [isInstallingCli]);

  const handleInstallSkills = useCallback(() => {
    if (isInstallingSkills) return;
    setIsInstallingSkills(true);
    void installSkills()
      .then(setSkillsStatus)
      .catch((error) => {
        console.error("[Integrations] Failed to install skills", error);
      })
      .finally(() => {
        setIsInstallingSkills(false);
      });
  }, [isInstallingSkills]);

  if (!showSection) {
    return null;
  }

  return (
    <View style={settingsStyles.section}>
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Integrations</Text>
        <View style={styles.headerLinks}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
            textStyle={settingsStyles.sectionHeaderLinkText}
            style={settingsStyles.sectionHeaderLink}
            onPress={() => void openExternalUrl(CLI_DOCS_URL)}
            accessibilityLabel="Open CLI documentation"
          >
            CLI docs
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
            textStyle={settingsStyles.sectionHeaderLinkText}
            style={settingsStyles.sectionHeaderLink}
            onPress={() => void openExternalUrl(SKILLS_DOCS_URL)}
            accessibilityLabel="Open skills documentation"
          >
            Skills docs
          </Button>
        </View>
      </View>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Terminal size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>Command line</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              Control and script agents from your terminal.
            </Text>
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
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Blocks size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>Orchestration skills</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              Teach your agents to orchestrate through the CLI.
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
    </View>
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
