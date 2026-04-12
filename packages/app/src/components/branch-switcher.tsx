import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";

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

  if (!currentBranchName) {
    return (
      <Text testID="workspace-header-title" style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
    );
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
        <GitBranch size={14} color={theme.colors.foregroundMuted} />
        <Text testID="workspace-header-title" style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <ChevronDown size={12} color={theme.colors.foregroundMuted} />
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
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  branchSwitcherTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexShrink: 1,
    minWidth: 0,
  },
  branchSwitcherTriggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
}));
