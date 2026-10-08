import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, type Pressable } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedGitBranch = withUnistyles(GitBranch);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface WorktreeBranchPickerProps {
  options: ComboboxOption[];
  value: string;
  label: string;
  onSelect: (id: string) => void;
  onSearchQueryChange: (query: string) => void;
  onOpenChange: (open: boolean) => void;
}

/** Chooses a new branch or a named existing branch before disclosing any base-ref picker. */
export function WorktreeBranchPicker({
  options,
  value,
  label,
  onSelect,
  onSearchQueryChange,
  onOpenChange,
  disabled,
  badgePressableStyle,
}: WorktreeBranchPickerProps & {
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange(nextOpen);
      if (!nextOpen) onSearchQueryChange("");
    },
    [onSearchQueryChange, onOpenChange],
  );
  const openPicker = useCallback(() => handleOpenChange(true), [handleOpenChange]);
  const select = useCallback(
    (id: string) => {
      onSelect(id);
      handleOpenChange(false);
    },
    [onSelect, handleOpenChange],
  );
  return (
    <>
      <ComboboxTrigger
        ref={anchorRef}
        testID="new-workspace-branch-picker-trigger"
        disabled={disabled}
        onPress={openPicker}
        style={badgePressableStyle}
        accessibilityRole="button"
        accessibilityLabel="Branch"
      >
        <ThemedGitBranch size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </ComboboxTrigger>
      <Combobox
        options={options}
        value={value}
        onSelect={select}
        onSearchQueryChange={onSearchQueryChange}
        searchable
        searchPlaceholder="Search branches"
        title="Branch"
        open={open}
        onOpenChange={handleOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={anchorRef}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, flexShrink: 1 },
}));
