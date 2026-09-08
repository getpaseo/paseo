import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Blocks, Check, Settings2 } from "lucide-react-native";
import type { AgentSkillOperation, AgentSkillsStatus } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { SkillSelectionSheet } from "./selection-sheet";
import { useAgentSkills } from "./use-agent-skills";

const OP_KIND_ORDER: Record<AgentSkillOperation["kind"], number> = {
  add: 0,
  update: 1,
  delete: 2,
};
const ThemedBlocks = withUnistyles(Blocks);
const ThemedCheck = withUnistyles(Check);
const ThemedSettings = withUnistyles(Settings2);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function formatUpdateMessage(ops: readonly AgentSkillOperation[], t: TFunction): string {
  return [...ops]
    .sort((a, b) => OP_KIND_ORDER[a.kind] - OP_KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
    .map((op) => `${t(`settings.host.skills.operations.${op.kind}`)} ${op.name}`)
    .join("\n");
}

export function AgentSkillsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const skills = useAgentSkills(serverId);
  const refreshSkills = skills.refresh;
  const skillsConnected = skills.connected;
  const skillsSupported = skills.supported;
  const [isChoosing, setIsChoosing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (skillsConnected && skillsSupported) void refreshSkills();
      return undefined;
    }, [refreshSkills, skillsConnected, skillsSupported]),
  );
  const maintenanceOps = useMemo(
    () => skills.status?.ops.filter((op) => op.kind !== "delete") ?? [],
    [skills.status?.ops],
  );
  const state =
    skills.status?.state === "drift" && maintenanceOps.length === 0
      ? "up-to-date"
      : (skills.status?.state ?? null);
  const hasSelected =
    (skills.status?.selection.mode === "all" && skills.status.available.length > 0) ||
    (skills.status?.selection.mode === "custom" &&
      skills.status.selection.skills.some((name) => skills.status?.available.includes(name)));

  const handleReconcile = useCallback(async () => {
    if (skills.isWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.updateTitle"),
      message:
        maintenanceOps.length > 0
          ? formatUpdateMessage(maintenanceOps, t)
          : t("settings.host.skills.updateFallback"),
      confirmLabel: t("settings.host.skills.actions.update"),
    });
    if (confirmed) await skills.reconcile();
  }, [maintenanceOps, skills, t]);
  const handleUninstall = useCallback(async () => {
    if (skills.isWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.uninstallTitle"),
      message: t("settings.host.skills.uninstallMessage"),
      confirmLabel: t("settings.host.skills.actions.uninstall"),
      destructive: true,
    });
    if (confirmed) await skills.uninstall();
  }, [skills, t]);
  const chooseIcon = useMemo(
    () => <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );
  const handleOpen = useCallback(() => setIsChoosing(true), []);
  const handleClose = useCallback(() => setIsChoosing(false), []);
  const handleOpenDocs = useCallback(() => {
    void openExternalUrl(SKILLS_DOCS_URL);
  }, []);
  const docsIcon = useMemo(
    () => <ThemedArrowUpRight size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );
  const trailing = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={docsIcon}
        textStyle={settingsStyles.sectionHeaderLinkText}
        style={settingsStyles.sectionHeaderLink}
        onPress={handleOpenDocs}
        accessibilityLabel={t("settings.host.skills.openDocs")}
      >
        {t("settings.host.skills.docs")}
      </Button>
    ),
    [docsIcon, handleOpenDocs, t],
  );

  if (!skills.connected || !skills.supported) {
    return (
      <SettingsSection title={t("settings.host.skills.sectionTitle")} trailing={trailing}>
        <View style={settingsStyles.card} testID="host-agent-skills-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.mutedText}>
              {skills.connected
                ? t("settings.host.skills.unsupported")
                : t("settings.host.skills.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("settings.host.skills.sectionTitle")} trailing={trailing}>
      <View style={settingsStyles.card} testID="host-agent-skills-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <ThemedBlocks size={ICON_SIZE.md} uniProps={foregroundMapping} />
              <Text style={settingsStyles.rowTitle}>{t("settings.host.skills.title")}</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {state === "drift"
                ? t("settings.host.skills.updateAvailable")
                : t("settings.host.skills.description")}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={chooseIcon}
              onPress={handleOpen}
              disabled={skills.status === null || skills.isWorking}
              accessibilityLabel={t("settings.host.skills.choose")}
            />
            {hasSelected ? (
              <SkillsActions
                state={state}
                isWorking={skills.isWorking}
                onInstall={skills.reconcile}
                onReconcile={handleReconcile}
                onUninstall={handleUninstall}
              />
            ) : null}
          </View>
        </View>
      </View>
      {skills.status ? (
        <SkillSelectionSheet
          visible={isChoosing}
          available={skills.status.available}
          selection={skills.status.selection}
          isSaving={skills.isWorking}
          onSave={skills.saveSelection}
          onClose={handleClose}
        />
      ) : null}
    </SettingsSection>
  );
}

function SkillsActions({
  state,
  isWorking,
  onReconcile,
  onInstall,
  onUninstall,
}: {
  state: AgentSkillsStatus["state"] | null;
  isWorking: boolean;
  onReconcile: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  if (state === "up-to-date") {
    return (
      <View style={styles.actionsRow}>
        <View style={styles.installedLabel}>
          <ThemedCheck size={14} uniProps={mutedMapping} />
          <Text style={styles.mutedText}>{t("settings.host.skills.actions.installed")}</Text>
        </View>
        <Button variant="outline" size="sm" onPress={onUninstall} disabled={isWorking}>
          {t("settings.host.skills.actions.uninstall")}
        </Button>
      </View>
    );
  }
  if (state === "drift") {
    return (
      <View style={styles.actionsRow}>
        <Button variant="outline" size="sm" onPress={onReconcile} disabled={isWorking}>
          {isWorking
            ? t("settings.host.skills.actions.working")
            : t("settings.host.skills.actions.update")}
        </Button>
        <Button variant="outline" size="sm" onPress={onUninstall} disabled={isWorking}>
          {t("settings.host.skills.actions.uninstall")}
        </Button>
      </View>
    );
  }
  return (
    <Button variant="outline" size="sm" onPress={onInstall} disabled={isWorking}>
      {isWorking
        ? t("settings.host.skills.actions.installing")
        : t("settings.host.skills.actions.install")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  installedLabel: { flexDirection: "row", alignItems: "center", gap: 4 },
  mutedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  emptyCard: { padding: theme.spacing[4] },
}));
