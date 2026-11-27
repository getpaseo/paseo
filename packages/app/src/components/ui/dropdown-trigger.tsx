import { AppearanceText as Text } from "@/appearance/text";
import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import {
  controlIconSize,
  createControlGeometry,
  type ControlSize,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";
import { DropdownMenuTrigger, type DropdownMenuTriggerProps } from "@/components/ui/dropdown-menu";
import { useContainedControlSize } from "@/components/ui/control-size";

const ThemedChevronDown = withUnistyles(ChevronDown);

const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface DropdownTriggerProps extends Omit<DropdownMenuTriggerProps, "children" | "style"> {
  /** The selected option's label. */
  children: string;
  /** Icon or swatch before the label. */
  leading?: ReactNode;
  size?: ControlSize;
}

/**
 * A select-style menu trigger: the selected value plus a chevron, drawn with the
 * outline Button's chrome and size scale so a dropdown and a button in the same
 * row share one geometry. Callers pick a size; they don't style it.
 */
export function DropdownTrigger({
  children,
  leading,
  size: sizeProp,
  disabled,
  ...props
}: DropdownTriggerProps): ReactElement {
  const containedSize = useContainedControlSize();
  const size = sizeProp ?? containedSize ?? "md";
  const sizeStyle = size === "sm" ? styles.sm : styles.md;
  const triggerStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.base,
      sizeStyle,
      pressed ? styles.pressed : null,
      disabled ? styles.disabled : null,
    ],
    [disabled, sizeStyle],
  );
  const labelStyle = useMemo(() => [styles.label, size === "sm" && styles.labelSm], [size]);

  return (
    <DropdownMenuTrigger {...props} disabled={disabled} style={triggerStyle}>
      {leading}
      <Text style={labelStyle} numberOfLines={1}>
        {children}
      </Text>
      <View style={styles.chevron}>
        <ThemedChevronDown size={controlIconSize[size]} uniProps={chevronColorMapping} />
      </View>
    </DropdownMenuTrigger>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    base: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      borderWidth: 1,
      borderColor: theme.colors.borderAccent,
      backgroundColor: "transparent",
    },
    sm: geometry.buttonSm,
    md: geometry.buttonMd,
    pressed: {
      opacity: 0.85,
    },
    disabled: {
      opacity: theme.opacity[50],
    },
    label: {
      flexShrink: 1,
      color: theme.colors.foreground,
      ...geometry.buttonTextMd,
    },
    labelSm: geometry.buttonTextSm,
    chevron: {
      transform: [{ translateY: 1 }],
    },
  };
});
