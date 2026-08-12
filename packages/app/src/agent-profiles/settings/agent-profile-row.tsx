import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, FileText, Pencil, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { AgentProfileGlyph } from "../internal/agent-profile-glyph";
import { buildAgentProfileTags } from "../internal/profile-summary";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedFileText = withUnistyles(FileText);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;

export interface AgentProfileRowProps {
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

export function AgentProfileRow({
  profile,
  entries,
  isFirst,
  isLast,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: AgentProfileRowProps): ReactElement {
  const { t } = useTranslation();

  const handleEdit = useCallback(() => onEdit(profile.id), [onEdit, profile.id]);
  const handleRemove = useCallback(() => onRemove(profile.id), [onRemove, profile.id]);
  const handleMoveUp = useCallback(() => onMoveUp(profile.id), [onMoveUp, profile.id]);
  const handleMoveDown = useCallback(() => onMoveDown(profile.id), [onMoveDown, profile.id]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );
  const tags = useMemo(
    () => buildAgentProfileTags({ profile, entries, formatFeatureCount }),
    [entries, formatFeatureCount, profile],
  );
  const summary = useMemo(() => tags.map((tag) => tag.label).join(" · "), [tags]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder, styles.row],
    [isFirst],
  );

  return (
    <View style={rowStyle} testID={`agent-profile-row-${profile.id}`}>
      <View style={styles.iconWrapper}>
        <AgentProfileGlyph icon={profile.icon} color={profile.color} size={ICON_SIZE.md} />
      </View>
      <View style={settingsStyles.rowContent}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {profile.name}
          </Text>
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        </View>
        {profile.notes ? (
          <View style={styles.notes}>
            <ThemedFileText size={ICON_SIZE.xs} uniProps={mutedColorMapping} />
            <Text
              style={styles.notesText}
              numberOfLines={2}
              testID={`agent-profile-notes-${profile.id}`}
            >
              {profile.notes}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={t("settings.host.agentProfiles.moveUp")}
          testID={`agent-profile-move-up-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={t("settings.host.agentProfiles.moveDown")}
          testID={`agent-profile-move-down-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editIcon}
          onPress={handleEdit}
          accessibilityLabel={t("settings.host.agentProfiles.editProfile")}
          testID={`agent-profile-edit-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeIcon}
          onPress={handleRemove}
          accessibilityLabel={t("settings.host.agentProfiles.remove")}
          testID={`agent-profile-remove-${profile.id}`}
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
  iconWrapper: {
    width: theme.iconSize.md,
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing[1],
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
    fontSize: theme.fontSize.xs,
  },
  notes: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  notesText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
  },
}));
