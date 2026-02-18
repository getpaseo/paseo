import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

type SegmentedControlSize = "sm" | "md";

type SegmentedControlIconRenderer = (props: {
  color: string;
  size: number;
}) => ReactNode;

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
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  style,
  testID,
}: SegmentedControlProps<T>) {
  const { theme } = useUnistyles();
  const segmentSizeStyle = size === "sm" ? styles.segmentSm : styles.segmentMd;
  const labelSizeStyle = size === "sm" ? styles.labelSm : styles.labelMd;
  const iconSize = size === "sm" ? 14 : 16;

  return (
    <View style={[styles.container, style]} testID={testID}>
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
            <Text
              style={[styles.label, labelSizeStyle, isSelected && styles.labelSelected]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    gap: 4,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: "transparent",
    gap: theme.spacing[1],
  },
  segmentSm: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  segmentMd: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  segmentSelected: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.border,
  },
  segmentHover: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
  segmentPressed: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
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
    fontSize: theme.fontSize.xs,
  },
  labelMd: {
    fontSize: theme.fontSize.sm,
  },
  labelSelected: {
    color: theme.colors.foreground,
  },
}));
