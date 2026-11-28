import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { ShortcutKey } from "@/utils/format-shortcut";

const EXIT_SHORTCUT_CHORD: ShortcutKey[][] = [["Esc"]];

export function WorkspaceSelectionToast({
  selectedCount,
  isArchiving,
  onArchive,
  onExit,
}: {
  selectedCount: number;
  isArchiving: boolean;
  onArchive: () => void;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  const exitLabel = t("sidebar.workspace.selection.exit");

  return (
    <View style={styles.row}>
      <Text style={styles.message} numberOfLines={1} testID="workspace-selection-count">
        {t("sidebar.workspace.selection.count", { count: selectedCount })}
      </Text>
      <View style={styles.actions}>
        <Button
          size="sm"
          onPress={onArchive}
          disabled={selectedCount === 0}
          loading={isArchiving}
          testID="workspace-selection-archive"
        >
          {t("sidebar.workspace.actions.archive")}
        </Button>
        <ToolbarButton
          round
          tooltipSide="top"
          label={exitLabel}
          shortcut={EXIT_SHORTCUT_CHORD}
          onPress={onExit}
          disabled={isArchiving}
          style={styles.exitButton}
          testID="workspace-selection-exit"
        >
          <DensityIcon icon={X} size="sm" color="foregroundMuted" />
        </ToolbarButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Matches the Archive button's sm pill height so the circular hover fill sits concentrically
  // in the action toast's trailing corner.
  exitButton: {
    width: CONTROL_HEIGHTS.sm,
    height: CONTROL_HEIGHTS.sm,
  },
}));
