import React, { memo, useCallback, type ReactElement } from "react";
import { type PressableStateCallbackType } from "react-native";
import { Archive, MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isNative as isTouchPlatform } from "@/constants/platform";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import type { Theme } from "@/styles/theme";

export interface SidebarSessionRowKebabMenuProps {
  serverId: string;
  agentId: string;
  isHovered: boolean;
}

const ThemedArchive = withUnistyles(Archive);
const ThemedMoreVertical = withUnistyles(MoreVertical);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;

function kebabButtonStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabButton, hovered && styles.kebabButtonHovered];
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

export const SidebarSessionRowKebabMenu = memo(function SidebarSessionRowKebabMenu({
  serverId,
  agentId,
  isHovered,
}: SidebarSessionRowKebabMenuProps): ReactElement | null {
  const visible = isHovered || isTouchPlatform;
  const { archiveAgent } = useArchiveAgent();

  const handleArchiveAgent = useCallback(() => {
    void archiveAgent({ serverId, agentId }).catch(() => {});
  }, [agentId, archiveAgent, serverId]);

  if (!visible) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabButtonStyle}
        accessibilityRole="button"
        accessibilityLabel="Session actions"
        testID={`sidebar-session-kebab-${serverId}-${agentId}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          testID={`sidebar-session-menu-${serverId}-${agentId}-archive`}
          leading={archiveLeadingIcon}
          onSelect={handleArchiveAgent}
        >
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  kebabButton: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
