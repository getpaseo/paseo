import { useRef } from "react";
import { Pressable, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import { ScreenTitle } from "@/components/headers/screen-title";

interface BranchSwitcherProps {
  currentBranchName: string | null;
  title: string;
  serverId: string;
  workspaceId: string;
  isGitCheckout: boolean;
}

export function BranchSwitcher({
  currentBranchName,
  title,
  serverId,
  workspaceId,
  isGitCheckout,
}: BranchSwitcherProps) {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const queryClient = useQueryClient();

  const { branchOptions, isOpen, setIsOpen, handleBranchSelect } = useBranchSwitcher({
    client,
    normalizedServerId: serverId,
    normalizedWorkspaceId: workspaceId,
    currentBranchName,
    isGitCheckout,
    isConnected,
    toast,
    queryClient,
  });

  const titleContent = (
    <View style={styles.titleRow}>
      {isGitCheckout ? <GitBranch size={14} color={theme.colors.foregroundMuted} /> : null}
      <ScreenTitle testID="workspace-header-title">{title}</ScreenTitle>
    </View>
  );

  if (!currentBranchName) {
    return <View style={styles.branchSwitcherTrigger}>{titleContent}</View>;
  }

  return (
    <View ref={anchorRef} collapsable={false}>
      <Pressable
        testID="workspace-header-branch-switcher"
        onPress={() => setIsOpen(true)}
        style={({ hovered, pressed }) => [
          styles.branchSwitcherTrigger,
          (hovered || pressed) && styles.branchSwitcherTriggerHovered,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Current branch: ${currentBranchName}. Press to switch branch.`}
      >
        {titleContent}
        {!isCompact ? <ChevronDown size={12} color={theme.colors.foregroundMuted} /> : null}
      </Pressable>
      <Combobox
        options={branchOptions}
        value={currentBranchName}
        onSelect={handleBranchSelect}
        searchable
        placeholder="Switch branch..."
        searchPlaceholder="Filter branches..."
        emptyText="No branches found."
        title="Switch branch"
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={({ option, selected, active, onPress }) => (
          <ComboboxItem
            key={option.id}
            label={option.label}
            selected={selected}
            active={active}
            onPress={onPress}
            leadingSlot={<GitBranch size={14} color={theme.colors.foregroundMuted} />}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  branchSwitcherTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    marginLeft: {
      xs: -theme.spacing[2],
      md: 0,
    },
    paddingVertical: {
      xs: 0,
      md: theme.spacing[1],
    },
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexShrink: 1,
  },
  branchSwitcherTriggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    overflow: "hidden",
  },
}));
