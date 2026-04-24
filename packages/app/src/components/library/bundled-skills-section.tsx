import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Blocks, Check } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import {
  getSkillsInstallStatus,
  installSkills,
  shouldUseDesktopDaemon,
  type InstallStatus,
} from "@/desktop/daemon/desktop-daemon";

/**
 * Bundled "Orchestration skills" pack that ships with Hubcode — moved out
 * of Settings → Integrations and into the Skills library so users find all
 * skill-related actions in one place. Writes the bundled skill files to
 * `~/.claude/skills/`, `~/.codex/skills/`, and `~/.agents/skills/` via the
 * desktop IPC bridge.
 */
export function BundledSkillsSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    if (!showSection) return;
    void getSkillsInstallStatus()
      .then(setStatus)
      .catch((err) => console.warn("[bundled-skills] status load failed", err));
  }, [showSection]);

  const handleInstall = useCallback(() => {
    if (isInstalling) return;
    setIsInstalling(true);
    void installSkills()
      .then(setStatus)
      .catch((err) => console.error("[bundled-skills] install failed", err))
      .finally(() => setIsInstalling(false));
  }, [isInstalling]);

  if (!showSection) return null;

  return (
    <View style={styles.wrapper}>
      <View style={styles.row}>
        <View style={styles.rowContent}>
          <View style={styles.titleRow}>
            <Blocks size={theme.iconSize.md} color={theme.colors.foreground} />
            <Text style={styles.title}>Orchestration skills</Text>
          </View>
          <Text style={styles.hint}>
            Bundled pack (
            {
              [
                "hubcode",
                "hubcode-loop",
                "hubcode-handoff",
                "hubcode-orchestrate",
                "hubcode-chat",
                "hubcode-committee",
              ].length
            }{" "}
            skills) that teaches your CLI agents to drive Hubcode workflows. Installed into
            `~/.claude/skills/`, `~/.codex/skills/`, and `~/.agents/skills/`.
          </Text>
        </View>
        {status?.installed ? (
          <View style={styles.installedLabel}>
            <Check size={14} color={theme.colors.foregroundMuted} />
            <Text style={styles.mutedText}>Installed</Text>
          </View>
        ) : (
          <Button variant="outline" size="sm" onPress={handleInstall} disabled={isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    marginBottom: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  rowContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  installedLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
