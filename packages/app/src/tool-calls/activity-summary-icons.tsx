import { memo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { componentForToolCallIcon } from "@/utils/tool-call-icon";
import type { ToolCallIcon } from "@/utils/tool-call-icon-name";

interface ToolCallActivityIconsBaseProps {
  iconNames: readonly ToolCallIcon[];
  iconColor?: string;
}

function ToolCallActivityIconsBase({ iconNames, iconColor }: ToolCallActivityIconsBaseProps) {
  if (iconNames.length === 0) {
    return null;
  }
  return (
    <View style={styles.container} pointerEvents="none" testID="tool-call-activity-icons">
      {iconNames.map((iconName) => {
        const Icon = componentForToolCallIcon(iconName);
        return (
          <View key={iconName} testID={`tool-call-activity-icon-${iconName}`}>
            <Icon size={13} color={iconColor} />
          </View>
        );
      })}
    </View>
  );
}

const iconColorMapping = (theme: Theme): Partial<ToolCallActivityIconsBaseProps> => ({
  iconColor: theme.colors.foregroundMuted,
});

const ThemedToolCallActivityIcons = withUnistyles(ToolCallActivityIconsBase);

export const ToolCallActivityIcons = memo(function ToolCallActivityIcons({
  iconNames,
}: {
  iconNames: readonly ToolCallIcon[];
}) {
  return <ThemedToolCallActivityIcons iconNames={iconNames} uniProps={iconColorMapping} />;
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[1],
  },
}));
