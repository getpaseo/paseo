import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

type SegmentedControlSize = "sm" | "md";

type SegmentedControlIconRenderer = (props: { color: string; size: number }) => ReactNode;

export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  icon?: SegmentedControlIconRenderer;
  disabled?: boolean;
  testID?: string;
};

type SegmentedControlProps<T extends string> = {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: SegmentedControlSize;
  hideLabels?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  hideLabels = false,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const { theme } = useUnistyles();
  const containerSizeStyle = size === "sm" ? styles.containerSm : styles.containerMd;
  const segmentSizeStyle = size === "sm" ? styles.segmentSm : styles.segmentMd;
  const labelSizeStyle = size === "sm" ? styles.labelSm : styles.labelMd;
  const iconSize = size === "sm" ? theme.iconSize.sm : theme.iconSize.md;

  return (
    <View style={[styles.container, containerSizeStyle, style]} testID={testID}>
      {options.map((option) => {
        const isSelected = option.value === value;
        const iconColor = isSelected ? theme.colors.foreground : theme.colors.foregroundMuted;

        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected, disabled: option.disabled }}
            disabled={option.disabled}
            testID={option.testID}
            onPress={() => {
              if (!option.disabled && option.value !== value) {
                onValueChange(option.value);
              }
            }}
            style={({ hovered, pressed }) => [
              styles.segment,
              segmentSizeStyle,
              isSelected && styles.segmentSelected,
              hovered && !isSelected && styles.segmentHover,
              pressed && !isSelected && styles.segmentPressed,
              option.disabled && styles.segmentDisabled,
            ]}
          >
            {option.icon ? (
              <View style={styles.iconContainer}>
                {option.icon({ color: iconColor, size: iconSize })}
              </View>
            ) : null}
            {hideLabels ? null : (
              <Text
                style={[styles.label, labelSizeStyle, isSelected && styles.labelSelected]}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "stretch",
    maxWidth: "100%",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
  },
  containerSm: {
    padding: 2,
  },
  containerMd: {
    padding: 3,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  segmentSm: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  segmentMd: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  segmentSelected: {
    backgroundColor: theme.colors.surface0,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentHover: {
    backgroundColor: theme.colors.surface1,
  },
  segmentPressed: {
    backgroundColor: theme.colors.surface1,
  },
  segmentDisabled: {
    opacity: theme.opacity[50],
  },
  iconContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  labelSm: {
    fontSize: theme.fontSize.sm,
  },
  labelMd: {
    fontSize: theme.fontSize.base,
  },
  labelSelected: {
    color: theme.colors.foreground,
  },
}));
