import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GitBranch, GitPullRequest } from "lucide-react-native";
import { ComboboxItem } from "@/components/ui/combobox";
import type { PickerItem } from "./new-workspace-picker-item";
import { pickerItemLabel, type PickerItemLabels } from "./new-workspace-picker-options";

function refPickerOptionTestId(item: PickerItem): string {
  switch (item.kind) {
    case "new-branch":
      return "new-workspace-ref-picker-new-branch";
    case "branch":
      return `new-workspace-ref-picker-branch-${item.name}`;
    case "github-pr":
      return `new-workspace-ref-picker-pr-${item.item.number}`;
  }
}

function refPickerOptionDescription(
  item: PickerItem,
  intoBaseLabel: (baseRef: string) => string,
): string | undefined {
  if (item.kind !== "github-pr" || !item.item.baseRefName) {
    return undefined;
  }
  return intoBaseLabel(item.item.baseRefName);
}

export function NewWorkspaceRefPickerOptionItem({
  item,
  labels,
  selected,
  active,
  disabled,
  onPress,
  intoBaseLabel,
  iconColor,
  iconSize,
}: {
  item: PickerItem;
  labels: PickerItemLabels;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  intoBaseLabel: (baseRef: string) => string;
  iconColor: string;
  iconSize: number;
}) {
  const isBranch = item.kind !== "github-pr";
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        {isBranch ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <GitPullRequest size={iconSize} color={iconColor} />
        )}
      </View>
    ),
    [isBranch, iconSize, iconColor],
  );

  const option = (
    <ComboboxItem
      testID={refPickerOptionTestId(item)}
      label={pickerItemLabel(item, labels)}
      description={refPickerOptionDescription(item, intoBaseLabel)}
      selected={selected}
      active={active}
      disabled={disabled}
      tone={item.kind === "new-branch" ? "success" : undefined}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );

  return option;
}

const styles = StyleSheet.create((theme) => ({
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
