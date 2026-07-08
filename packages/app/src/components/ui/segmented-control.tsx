import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  createControlGeometry,
  segmentedIconSize,
  type SegmentedControlSize,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";

type SegmentedControlIconRenderer = (props: { color: string; size: number }) => ReactNode;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: SegmentedControlIconRenderer;
  disabled?: boolean;
  testID?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: SegmentedControlSize;
  hideLabels?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface SegmentIconProps {
  icon: SegmentedControlIconRenderer;
  iconSize: number;
  iconColor: string;
}

function SegmentIcon({ icon, iconSize, iconColor }: SegmentIconProps) {
  return <View style={styles.iconContainer}>{icon({ color: iconColor, size: iconSize })}</View>;
}

const ThemedSegmentIcon = withUnistyles(SegmentIcon);

const selectedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });
const mutedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foregroundMuted });

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  hideLabels = false,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const containerSizeStyle = size === "sm" ? styles.containerSm : styles.containerMd;
  const segmentSizeStyle = size === "sm" ? styles.segmentSm : styles.segmentMd;
  const labelSizeStyle = size === "sm" ? styles.labelSm : styles.labelMd;
  const iconSize = segmentedIconSize[size];

  const containerStyle = useMemo(
    () => [styles.container, containerSizeStyle, style],
    [containerSizeStyle, style],
  );

  return (
    <View style={containerStyle} testID={testID}>
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <SegmentItem
            key={option.value}
            option={option}
            isSelected={isSelected}
            iconSize={iconSize}
            hideLabels={hideLabels}
            segmentSizeStyle={segmentSizeStyle}
            labelSizeStyle={labelSizeStyle}
            currentValue={value}
            onValueChange={onValueChange}
          />
        );
      })}
    </View>
  );
}

function SegmentItem<T extends string>({
  option,
  isSelected,
  iconSize,
  hideLabels,
  segmentSizeStyle,
  labelSizeStyle,
  currentValue,
  onValueChange,
}: {
  option: SegmentedControlOption<T>;
  isSelected: boolean;
  iconSize: number;
  hideLabels: boolean;
  segmentSizeStyle: StyleProp<ViewStyle>;
  labelSizeStyle: StyleProp<TextStyle>;
  currentValue: T;
  onValueChange: (value: T) => void;
}) {
  const labelStyle = useMemo(
    () => [styles.label, labelSizeStyle, isSelected && styles.labelSelected],
    [labelSizeStyle, isSelected],
  );
  const handlePress = useCallback(() => {
    if (!option.disabled && option.value !== currentValue) {
      onValueChange(option.value);
    }
  }, [option.disabled, option.value, currentValue, onValueChange]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.segment,
      segmentSizeStyle,
      isSelected && styles.segmentSelected,
      Boolean(hovered) && !isSelected && styles.segmentHover,
      pressed && !isSelected && styles.segmentPressed,
      option.disabled && styles.segmentDisabled,
    ],
    [isSelected, option.disabled, segmentSizeStyle],
  );
  const accessibilityState = useMemo(
    () => ({ selected: isSelected, disabled: option.disabled }),
    [isSelected, option.disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      aria-selected={isSelected}
      disabled={option.disabled}
      testID={option.testID}
      onPress={handlePress}
      style={pressableStyle}
    >
      {option.icon ? (
        <ThemedSegmentIcon
          icon={option.icon}
          iconSize={iconSize}
          uniProps={isSelected ? selectedIconMapping : mutedIconMapping}
        />
      ) : null}
      {hideLabels ? null : (
        <Text style={labelStyle} numberOfLines={1}>
          {option.label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    container: {
      flexDirection: "row",
      alignItems: "stretch",
      backgroundColor: theme.colors.surface2,
      gap: 2,
    },
    containerSm: {
      ...geometry.segmentedContainerSm,
    },
    containerMd: {
      ...geometry.segmentedContainerMd,
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      gap: theme.spacing[1],
    },
    segmentSm: {
      ...geometry.segmentedSegmentSm,
    },
    segmentMd: {
      ...geometry.segmentedSegmentMd,
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
      ...geometry.segmentedLabelSm,
    },
    labelMd: {
      ...geometry.segmentedLabelMd,
    },
    labelSelected: {
      color: theme.colors.foreground,
    },
  };
});
