import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router/react-navigation";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Settings2 } from "lucide-react-native";
import type { AgentSkillOperation, AgentSkillsStatus } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { SkillSelectionSheet } from "./selection-sheet";
import { useAgentSkills, type AgentSkillsController } from "./use-agent-skills";

export { useAgentSkills, type AgentSkillsController } from "./use-agent-skills";

const OP_KIND_ORDER: Record<AgentSkillOperation["kind"], number> = {
  add: 0,
  update: 1,
  delete: 2,
};
const ThemedSettings = withUnistyles(Settings2);
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function formatUpdateMessage(ops: readonly AgentSkillOperation[], t: TFunction): string {
  return [...ops]
    .sort((a, b) => OP_KIND_ORDER[a.kind] - OP_KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
    .map((op) => `${t(`settings.host.skills.operations.${op.kind}`)} ${op.name}`)
    .join("\n");
}

/** Whether the host has Paseo's skills installed in any form, current or not. */
export function areSkillsInstalled(status: AgentSkillsStatus | null): boolean {
  return status !== null && status.state !== "not-installed";
}

/** Whether the saved selection names any skill there is to install. */
export function hasSelectedSkills(status: AgentSkillsStatus | null): boolean {
  if (!status) return false;
  if (status.selection.mode === "all") return status.available.length > 0;
  return status.selection.skills.some((name) => status.available.includes(name));
}

export function AgentSkillsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const skills = useAgentSkills(serverId);
  const { refresh, connected, supported, reconcile, uninstall } = skills;
  useFocusEffect(
    useCallback(() => {
      if (connected && supported) void refresh();
      return undefined;
    }, [refresh, connected, supported]),
  );
  const handleValueChange = useCallback(
    (next: boolean) => {
      void (next ? reconcile() : uninstall());
    },
    [reconcile, uninstall],
  );
  const docsLink = useMemo(
    () => ({
      href: SKILLS_DOCS_URL,
      label: t("settings.host.skills.docs"),
      accessibilityLabel: t("settings.host.skills.openDocs"),
    }),
    [t],
  );

  if (!connected || !supported) {
    return (
      <SettingsSection title={t("settings.host.skills.sectionTitle")} link={docsLink}>
        <View style={settingsStyles.card} testID="host-agent-skills-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.mutedText}>
              {connected
                ? t("settings.host.skills.unsupported")
                : t("settings.host.skills.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("settings.host.skills.sectionTitle")} link={docsLink}>
      <SettingsCard testID="host-agent-skills-card">
        <AgentSkillsRow
          skills={skills}
          value={areSkillsInstalled(skills.status)}
          onValueChange={handleValueChange}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * The orchestration skills row: a switch for whether they are installed, a gear that opens the
 * skill picker, and Update when the installed skills fall behind the bundled ones. The caller
 * decides what the switch is bound to; the picker and Update always act on the host.
 */
export function AgentSkillsRow({
  skills,
  value,
  onValueChange,
  disabled = false,
}: {
  skills: AgentSkillsController;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { status, isWorking, reconcile, saveSelection } = skills;
  const [isChoosing, setIsChoosing] = useState(false);
  // Deleting a deselected skill is a choice made in the picker, not an update to offer here.
  const maintenanceOps = useMemo(
    () => status?.ops.filter((op) => op.kind !== "delete") ?? [],
    [status?.ops],
  );
  const needsUpdate = status?.state === "drift" && maintenanceOps.length > 0;

  const handleUpdate = useCallback(async () => {
    if (isWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.host.skills.updateTitle"),
      message: formatUpdateMessage(maintenanceOps, t),
      confirmLabel: t("settings.host.skills.actions.update"),
    });
    if (confirmed) await reconcile();
  }, [isWorking, maintenanceOps, reconcile, t]);
  const handleOpen = useCallback(() => setIsChoosing(true), []);
  const handleClose = useCallback(() => setIsChoosing(false), []);
  const chooseIcon = useMemo(
    () => <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedMapping} />,
    [],
  );

  return (
    <>
      <SettingsRow
        label={t("settings.host.skills.title")}
        hint={
          needsUpdate
            ? t("settings.host.skills.updateAvailable")
            : t("settings.host.skills.description")
        }
      >
        <View style={styles.controls}>
          {needsUpdate ? (
            <Button variant="outline" onPress={handleUpdate} disabled={disabled || isWorking}>
              {isWorking
                ? t("settings.host.skills.actions.working")
                : t("settings.host.skills.actions.update")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            leftIcon={chooseIcon}
            onPress={handleOpen}
            disabled={disabled || status === null || isWorking}
            accessibilityLabel={t("settings.host.skills.choose")}
          />
          <Switch
            value={value}
            onValueChange={onValueChange}
            // Nothing picked means nothing to install; the gear is the way forward.
            disabled={
              disabled || status === null || isWorking || (!value && !hasSelectedSkills(status))
            }
            accessibilityLabel={t("settings.host.skills.title")}
          />
        </View>
      </SettingsRow>
      {status ? (
        <SkillSelectionSheet
          visible={isChoosing}
          available={status.available}
          selection={status.selection}
          isSaving={isWorking}
          onSave={saveSelection}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  mutedText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  emptyCard: { padding: theme.spacing[4] },
}));
