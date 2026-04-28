// TaskSettingsCard — adapted from emdash's TaskSettingsCard + TaskSettingsRows
// Settings for task behavior (auto-generate names, auto-approve, worktrees)

import { View, Text, Switch } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

interface SettingRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}

function SettingRow({ label, description, value, onValueChange }: SettingRowProps) {
  const { theme } = useUnistyles();

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowText}>
        <Text style={settingsStyles.rowLabel}>{label}</Text>
        {description ? <Text style={settingsStyles.rowDescription}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{
          false: theme.colors.surface2,
          true: theme.colors.foreground,
        }}
      />
    </View>
  );
}

export interface TaskSettings {
  autoGenerateNames: boolean;
  autoApproveByDefault: boolean;
  createWorktreeByDefault: boolean;
  autoTrustWorktrees: boolean;
}

interface TaskSettingsCardProps {
  settings: TaskSettings;
  onSettingsChange: (settings: Partial<TaskSettings>) => void;
}

export function TaskSettingsCard({ settings, onSettingsChange }: TaskSettingsCardProps) {
  return (
    <View style={settingsStyles.container}>
      <Text style={settingsStyles.title}>Task Settings</Text>
      <View style={settingsStyles.rows}>
        <SettingRow
          label="Auto-generate task names"
          description="Automatically generate friendly names for new tasks"
          value={settings.autoGenerateNames}
          onValueChange={(v) => onSettingsChange({ autoGenerateNames: v })}
        />
        <SettingRow
          label="Auto-approve by default"
          description="Skip permission prompts for file operations in new tasks"
          value={settings.autoApproveByDefault}
          onValueChange={(v) => onSettingsChange({ autoApproveByDefault: v })}
        />
        <SettingRow
          label="Create worktree by default"
          description="Use local git worktrees for task isolation"
          value={settings.createWorktreeByDefault}
          onValueChange={(v) => onSettingsChange({ createWorktreeByDefault: v })}
        />
        <SettingRow
          label="Auto-trust worktrees"
          description="Automatically trust worktree directories"
          value={settings.autoTrustWorktrees}
          onValueChange={(v) => onSettingsChange({ autoTrustWorktrees: v })}
        />
      </View>
    </View>
  );
}

const settingsStyles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  rows: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
