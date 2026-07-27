import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedSquareTerminal = withUnistyles(SquareTerminal);

const terminalIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TerminalTreeRowProps {
  terminalId: string;
  name: string;
  title: string | null;
  serverId: string;
  workspaceId: string;
  onWorkspacePress?: () => void;
}

export const TerminalTreeRow = memo(function TerminalTreeRow({
  terminalId,
  name,
  title,
  serverId,
  workspaceId,
  onWorkspacePress,
}: TerminalTreeRowProps) {
  const [hovered, setHovered] = useState(false);
  const label = title?.trim() || name.trim() || terminalId;

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "terminal", terminalId },
    });
  }, [onWorkspacePress, serverId, workspaceId, terminalId]);

  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const rowStyle = useMemo(() => [styles.row, hovered && styles.rowHovered], [hovered]);

  return (
    <View
      style={rowStyle}
      onPointerEnter={isNative ? undefined : handlePointerEnter}
      onPointerLeave={isNative ? undefined : handlePointerLeave}
    >
      <View style={styles.chevronSpacer} />
      <Pressable
        onPress={handleNavigate}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.labelArea}
      >
        <View style={styles.iconSlot}>
          <ThemedSquareTerminal size={14} uniProps={terminalIconColorMapping} />
        </View>
        <View style={styles.statusSlot} />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    minHeight: 28,
  },
  chevronSpacer: {
    width: 20,
    flexShrink: 0,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  labelArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[1],
  },
  iconSlot: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusSlot: {
    width: 16,
    flexShrink: 0,
  },
  label: {
    flex: 1,
    minWidth: 0,
    marginLeft: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    opacity: 0.85,
  },
}));
