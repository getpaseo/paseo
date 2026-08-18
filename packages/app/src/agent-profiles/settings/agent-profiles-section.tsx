import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useAgentProfiles } from "../internal/use-agent-profiles";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { AgentProfileEditModal } from "./agent-profile-edit-modal";
import { AgentProfileRow } from "./agent-profile-row";

const ThemedPlus = withUnistyles(Plus);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const addIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function generateAgentProfileId(): string {
  return `agent_profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

interface EditTarget {
  mode: "create" | "edit";
  profile?: AgentProfile;
}

export function AgentProfilesSection({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { profiles, isSupported, saveProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const handleAddOpen = useCallback(() => setEditTarget({ mode: "create" }), []);
  const handleEditClose = useCallback(() => setEditTarget(null), []);

  const handleEditOpen = useCallback(
    (id: string) => {
      const profile = profiles?.find((entry) => entry.id === id);
      if (!profile) {
        return;
      }
      setEditTarget({ mode: "edit", profile });
    },
    [profiles],
  );

  const handleSave = useCallback(
    async (value: AgentProfileValue) => {
      const current = profiles ?? [];
      const editing = editTarget?.mode === "edit" ? editTarget.profile : undefined;
      // The edited profile is replaced, not merged: `value` omits the fields the
      // user cleared, so spreading it over the stored record would silently keep
      // the old model, mode, thinking option or notes.
      const next: AgentProfile[] = editing
        ? current.map((entry) => (entry.id === editing.id ? { id: entry.id, ...value } : entry))
        : [...current, { id: generateAgentProfileId(), ...value }];
      await saveProfiles(next);
    },
    [editTarget, profiles, saveProfiles],
  );

  const reorder = useCallback(
    async (id: string, offset: -1 | 1) => {
      if (!profiles) {
        return;
      }
      const index = profiles.findIndex((entry) => entry.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= profiles.length) {
        return;
      }
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, saveProfiles, t],
  );

  const handleMoveUp = useCallback((id: string) => void reorder(id, -1), [reorder]);
  const handleMoveDown = useCallback((id: string) => void reorder(id, 1), [reorder]);

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((entry) => entry.id === id);
      if (!profile) {
        return;
      }
      void confirmDialog({
        title: t("settings.host.agentProfiles.removeConfirmTitle"),
        message: t("settings.host.agentProfiles.removeConfirmMessage", { name: profile.name }),
        confirmLabel: t("settings.host.agentProfiles.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !profiles) {
          return;
        }
        try {
          await saveProfiles(profiles.filter((entry) => entry.id !== id));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      });
    },
    [profiles, saveProfiles, t],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleAddOpen}
        disabled={!profiles}
        accessibilityLabel={t("settings.host.agentProfiles.addProfileTitle")}
        testID="agent-profiles-add-button"
      />
    ),
    [handleAddOpen, profiles, t],
  );

  if (!isConnected || !isSupported) {
    return (
      <SettingsSection
        title={t("settings.host.agentProfiles.sectionTitle")}
        testID="agent-profiles-section"
      >
        <View style={settingsStyles.card} testID="agent-profiles-unavailable">
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              {isConnected
                ? t("settings.host.agentProfiles.unsupported")
                : t("settings.host.agentProfiles.unavailable")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.agentProfiles.sectionTitle")}
        trailing={addButton}
        testID="agent-profiles-section"
      >
        <View style={settingsStyles.card} testID="agent-profiles-card">
          {profiles && profiles.length > 0 ? (
            profiles.map((profile, index) => (
              <AgentProfileRow
                key={profile.id}
                profile={profile}
                entries={entries}
                isFirst={index === 0}
                isLast={index === profiles.length - 1}
                onEdit={handleEditOpen}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
              />
            ))
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText} testID="agent-profiles-empty">
                {t("settings.host.agentProfiles.emptyState")}
              </Text>
              <Button size="sm" leftIcon={addIcon} onPress={handleAddOpen} disabled={!profiles}>
                {t("settings.host.agentProfiles.newProfile")}
              </Button>
            </View>
          )}
        </View>
      </SettingsSection>

      <AgentProfileEditModal
        serverId={serverId}
        visible={editTarget !== null}
        mode={editTarget?.mode ?? "create"}
        {...(editTarget?.profile ? { profile: editTarget.profile } : {})}
        onClose={handleEditClose}
        onSave={handleSave}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
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
