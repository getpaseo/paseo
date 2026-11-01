import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentTeamConfigWire } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { applyTeamEdit, removeTeam } from "./team-form-model";
import { TeamEditModal, type TeamEditSaveValue } from "./team-edit-modal";
import { useAgentTeamsConfig } from "./use-agent-teams-config";

const ThemedPlus = withUnistyles(Plus);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const addIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;

interface EditTarget {
  mode: "create" | "edit";
  name?: string;
}

/** Teams in `daemon.teams`, edited through the daemon config and applied without a restart. */
export function AgentTeamsSection({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { teams, isSupported, saveTeams } = useAgentTeamsConfig(serverId);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const teamEntries = useMemo(() => Object.entries(teams ?? {}), [teams]);
  const teamNames = useMemo(() => teamEntries.map(([name]) => name), [teamEntries]);
  const editingTeam = editTarget?.name !== undefined ? teams?.[editTarget.name] : undefined;

  const handleAddOpen = useCallback(() => setEditTarget({ mode: "create" }), []);
  const handleEditOpen = useCallback((name: string) => setEditTarget({ mode: "edit", name }), []);
  const handleEditClose = useCallback(() => setEditTarget(null), []);

  const handleSave = useCallback(
    async (value: TeamEditSaveValue) => {
      await saveTeams(applyTeamEdit({ teams: teams ?? {}, ...value }));
    },
    [saveTeams, teams],
  );

  const handleRemove = useCallback(
    (name: string) => {
      void confirmDialog({
        title: t("settings.host.agentTeams.removeConfirmTitle"),
        message: t("settings.host.agentTeams.removeConfirmMessage", { name }),
        confirmLabel: t("settings.host.agentTeams.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !teams) return;
        try {
          await saveTeams(removeTeam(teams, name));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      });
    },
    [saveTeams, t, teams],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleAddOpen}
        disabled={!teams}
        accessibilityLabel={t("settings.host.agentTeams.addTeamTitle")}
        testID="agent-teams-add-button"
      />
    ),
    [handleAddOpen, teams, t],
  );

  if (!isConnected || !isSupported) {
    return (
      <SettingsSection
        title={t("settings.host.agentTeams.sectionTitle")}
        testID="agent-teams-section"
      >
        <View style={settingsStyles.card} testID="agent-teams-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {isConnected
                ? t("settings.host.agentTeams.unsupported")
                : t("settings.host.agentTeams.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.agentTeams.sectionTitle")}
        trailing={addButton}
        testID="agent-teams-section"
      >
        <View style={settingsStyles.card} testID="agent-teams-card">
          {teamEntries.length > 0 ? (
            teamEntries.map(([name, team], index) => (
              <AgentTeamRow
                key={name}
                name={name}
                team={team}
                isFirst={index === 0}
                onEdit={handleEditOpen}
                onRemove={handleRemove}
              />
            ))
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText} testID="agent-teams-empty">
                {t("settings.host.agentTeams.emptyState")}
              </Text>
              <Button size="sm" leftIcon={addIcon} onPress={handleAddOpen} disabled={!teams}>
                {t("settings.host.agentTeams.newTeam")}
              </Button>
            </View>
          )}
        </View>
      </SettingsSection>

      <TeamEditModal
        serverId={serverId}
        visible={editTarget !== null}
        mode={editTarget?.mode ?? "create"}
        {...(editTarget?.name !== undefined ? { teamName: editTarget.name } : {})}
        {...(editingTeam ? { team: editingTeam } : {})}
        existingTeamNames={teamNames}
        onClose={handleEditClose}
        onSave={handleSave}
      />
    </>
  );
}

function AgentTeamRow({
  name,
  team,
  isFirst,
  onEdit,
  onRemove,
}: {
  name: string;
  team: AgentTeamConfigWire;
  isFirst: boolean;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(name), [name, onEdit]);
  const handleRemove = useCallback(() => onRemove(name), [name, onRemove]);
  const roles = useMemo(() => Object.keys(team.roles).join(", "), [team.roles]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder, styles.row],
    [isFirst],
  );

  return (
    <View style={rowStyle} testID={`agent-team-row-${name}`}>
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.summary} numberOfLines={1}>
            {roles}
          </Text>
        </View>
        {team.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {team.description}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editIcon}
          onPress={handleEdit}
          accessibilityLabel={t("settings.host.agentTeams.editTeam")}
          testID={`agent-team-edit-${name}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeIcon}
          onPress={handleRemove}
          accessibilityLabel={t("settings.host.agentTeams.remove")}
          testID={`agent-team-remove-${name}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    minHeight: 56,
    alignItems: "center",
    paddingVertical: theme.spacing[3],
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  summary: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  emptyCard: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
