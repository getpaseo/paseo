import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Copy, Info } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Fonts } from "@/constants/theme";
import { useToast } from "@/contexts/toast-context";

export type AgentDetailsSheetProps = {
  visible: boolean;
  onClose: () => void;
  agentId: string;
  persistenceSessionId: string | null;
};

export function AgentDetailsSheet({
  visible,
  onClose,
  agentId,
  persistenceSessionId,
}: AgentDetailsSheetProps) {
  const toast = useToast();

  const details = useMemo(
    () => [
      {
        label: "Agent ID",
        value: agentId,
        testID: "agent-details-agent-id",
        copyLabel: "agent id",
      },
      {
        label: "Persistence session ID",
        value: persistenceSessionId,
        testID: "agent-details-persistence-session-id",
        copyLabel: "session id",
      },
    ],
    [agentId, persistenceSessionId]
  );

  const handleCopy = useCallback(
    async (value: string | null, label: string) => {
      if (!value) return;
      try {
        await Clipboard.setStringAsync(value);
        toast.copied(label);
      } catch {
        toast.error("Copy failed");
      }
    },
    [toast]
  );

  return (
    <AdaptiveModalSheet
      title="Agent Details"
      visible={visible}
      onClose={onClose}
      testID="agent-details-sheet"
      snapPoints={["45%", "70%"]}
    >
      {details.map((row) => (
        <DetailRow
          key={row.label}
          label={row.label}
          value={row.value}
          onCopy={() => void handleCopy(row.value, row.copyLabel)}
          testID={row.testID}
          disabled={!row.value}
        />
      ))}
    </AdaptiveModalSheet>
  );
}

function DetailRow({
  label,
  value,
  onCopy,
  disabled,
  testID,
}: {
  label: string;
  value: string | null;
  onCopy: () => void;
  disabled?: boolean;
  testID: string;
}) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label} copy`}
      accessibilityHint={disabled ? "Not available" : "Copies to clipboard"}
      disabled={disabled}
      onPress={onCopy}
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.rowDisabled : null,
        pressed && !disabled ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.rowTop}>
        <View style={styles.labelRow}>
          <Info size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.label}>{label}</Text>
        </View>
        <View style={styles.copyPill}>
          <Copy size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.copyText}>Copy</Text>
        </View>
      </View>

      <Text
        testID={`${testID}-value`}
        style={[styles.value, !value ? styles.valueEmpty : null]}
        numberOfLines={2}
        ellipsizeMode="middle"
      >
        {value ?? "Not available"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[5],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowDisabled: {
    opacity: 0.65,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flex: 1,
  },
  copyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  copyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: Fonts.mono,
  },
  valueEmpty: {
    color: theme.colors.foregroundMuted,
    fontFamily: Fonts.sans,
  },
}));
