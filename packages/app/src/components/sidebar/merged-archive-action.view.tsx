import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Archive } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { META_ICON_SIZE } from "@/components/sidebar/workspace-meta-row";
import { shouldShowMergedArchiveAction } from "@/components/sidebar/merged-archive-action";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";

const ThemedArchive = withUnistyles(Archive);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function SidebarMergedArchiveAction({
  workspace,
  onArchive,
  archiveStatus = "idle",
}: {
  workspace: SidebarWorkspaceEntry;
  onArchive?: () => void;
  archiveStatus?: "idle" | "pending" | "success";
}): ReactElement | null {
  const { t } = useTranslation();

  // The row underneath is itself pressable, so both the press and the press-in that would
  // select it have to stop here — same contract as the change-request link next door.
  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onArchive?.();
    },
    [onArchive],
  );

  if (
    !shouldShowMergedArchiveAction({
      prHint: workspace.prHint,
      hasArchiveAction: Boolean(onArchive),
      archiveStatus,
    })
  ) {
    return null;
  }

  const label = t("sidebar.workspace.actions.archiveMerged");
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={`sidebar-workspace-archive-merged-${workspace.workspaceKey}`}
          hitSlop={6}
          onPressIn={handlePressIn}
          onPress={handlePress}
          style={styles.button}
        >
          {({ hovered, pressed }) => (
            <ThemedArchive
              size={META_ICON_SIZE}
              uniProps={hovered || pressed ? foregroundMapping : mutedMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  // No padding: the meta line is one text line tall and any box around the glyph grows it.
  // `hitSlop` buys the touch target back instead.
  button: {
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
