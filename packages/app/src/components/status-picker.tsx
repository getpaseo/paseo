import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useChatStore, type UserStatus } from "@/stores/chat-store";

const OPTIONS: { id: UserStatus; label: string; description: string; color: string }[] = [
  { id: "active", label: "Active", description: "Online and available", color: "#3ecf4f" },
  { id: "busy", label: "Busy", description: "Please do not disturb", color: "#e05252" },
  { id: "offline", label: "Offline", description: "Appear offline", color: "#9aa0a6" },
];

export function StatusDot({ status, size = 10 }: { status: UserStatus; size?: number }) {
  const { theme } = useUnistyles();
  const color =
    status === "active" ? "#3ecf4f" : status === "busy" ? "#e05252" : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: 2,
        borderColor: theme.colors.surface0,
      }}
    />
  );
}

interface StatusPickerProps {
  visible: boolean;
  onClose: () => void;
}

export function StatusPicker({ visible, onClose }: StatusPickerProps) {
  const { theme } = useUnistyles();
  const myStatus = useChatStore((s) => s.myStatus);
  const setMyStatus = useChatStore((s) => s.setMyStatus);

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title="Set status">
      <View style={styles.list}>
        {OPTIONS.map((opt) => {
          const active = opt.id === myStatus;
          return (
            <Pressable
              key={opt.id}
              onPress={() => {
                setMyStatus(opt.id);
                onClose();
              }}
              style={({ hovered = false }) => [styles.row, hovered && styles.rowHover]}
              accessibilityRole="button"
              accessibilityLabel={`Set status to ${opt.label}`}
            >
              <View style={[styles.dot, { backgroundColor: opt.color }]} />
              <View style={styles.text}>
                <Text style={styles.label}>{opt.label}</Text>
                <Text style={styles.description}>{opt.description}</Text>
              </View>
              {active ? <Check size={16} color={theme.colors.accent} /> : null}
            </Pressable>
          );
        })}
      </View>
    </AdaptiveModalSheet>
  );
}

interface StatusPickerTriggerProps {
  children: (open: () => void) => React.ReactElement;
}

export function StatusPickerTrigger({ children }: StatusPickerTriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <StatusPicker visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[1] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    minHeight: 48,
  },
  rowHover: { backgroundColor: theme.colors.surface2 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  text: { flex: 1, gap: 2 },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
