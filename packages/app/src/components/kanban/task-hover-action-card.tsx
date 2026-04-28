// TaskHoverActionCard — settings for configuring hover action on tasks
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Trash2, Archive, Check } from "lucide-react-native";

export type HoverAction = "delete" | "archive";

interface TaskHoverActionCardProps {
  value: HoverAction;
  onChange: (action: HoverAction) => void;
}

export function TaskHoverActionCard({ value, onChange }: TaskHoverActionCardProps) {
  const { theme } = useUnistyles();

  const options: Array<{ id: HoverAction; label: string; icon: typeof Trash2 }> = [
    { id: "delete", label: "Delete task", icon: Trash2 },
    { id: "archive", label: "Archive task", icon: Archive },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Primary action</Text>
      <Text style={styles.subtitle}>
        Choose what happens when you use the quick action on a task
      </Text>
      <View style={styles.options}>
        {options.map((opt) => {
          const isSelected = value === opt.id;
          const Icon = opt.icon;
          return (
            <Pressable
              key={opt.id}
              style={[styles.option, isSelected && styles.optionSelected]}
              onPress={() => onChange(opt.id)}
            >
              <Icon
                size={14}
                color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
              <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>
                {opt.label}
              </Text>
              {isSelected ? <Check size={14} color={theme.colors.foreground} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { gap: theme.spacing[2] },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  subtitle: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  options: { gap: theme.spacing[1] },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  optionSelected: { borderWidth: 1, borderColor: theme.colors.foreground },
  optionText: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  optionTextSelected: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
}));
