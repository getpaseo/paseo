import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, GitBranch } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";

interface BranchSwitcherProps {
  currentBranchName: string | null;
  title: string;
  branchOptions: ComboboxOption[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onBranchSelect: (branchId: string) => void;
}

export function BranchSwitcher({
  currentBranchName,
  title,
  branchOptions,
  isOpen,
  onOpenChange,
  onBranchSelect,
}: BranchSwitcherProps) {
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);

  if (!currentBranchName) {
    return (
      <Text
        testID="workspace-header-title"
        style={styles.headerTitle}
        numberOfLines={1}
      >
        {title}
      </Text>
    );
  }

  return (
    <View ref={anchorRef} collapsable={false}>
      <Pressable
        testID="workspace-header-branch-switcher"
        onPress={() => onOpenChange(true)}
        style={({ hovered, pressed }) => [
          styles.branchSwitcherTrigger,
          (hovered || pressed) && styles.branchSwitcherTriggerHovered,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Current branch: ${currentBranchName}. Press to switch branch.`}
      >
        <GitBranch
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text
          testID="workspace-header-title"
          style={styles.headerTitle}
          numberOfLines={1}
        >
          {title}
        </Text>
        <ChevronDown
          size={12}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      <Combobox
        options={branchOptions}
        value={currentBranchName}
        onSelect={onBranchSelect}
        searchable
        placeholder="Switch branch..."
        searchPlaceholder="Filter branches..."
        emptyText="No branches found."
        title="Switch branch"
        open={isOpen}
        onOpenChange={onOpenChange}
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
            leadingSlot={
              <GitBranch
                size={14}
                color={theme.colors.foregroundMuted}
              />
            }
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
