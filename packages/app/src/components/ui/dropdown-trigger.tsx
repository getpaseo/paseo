import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import {
  buttonIconSize,
  createControlGeometry,
  type ButtonControlSize,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";
import { DropdownMenuTrigger, type DropdownMenuTriggerProps } from "@/components/ui/dropdown-menu";

const ThemedChevronDown = withUnistyles(ChevronDown);

const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface DropdownTriggerProps extends Omit<DropdownMenuTriggerProps, "children" | "style"> {
  /** The selected option's label. */
  children: string;
  /** Icon or swatch before the label. */
  leading?: ReactNode;
  size?: ButtonControlSize;
}

/**
 * A select-style menu trigger: the selected value plus a chevron, drawn with the
 * outline Button's chrome and size scale so a dropdown and a button in the same
 * row share one geometry. Callers pick a size; they don't style it.
 */
export function DropdownTrigger({
  children,
  leading,
  size = "sm",
  disabled,
  ...props
}: DropdownTriggerProps): ReactElement {
  let sizeStyle: ViewStyle;
  if (size === "xs") {
    sizeStyle = styles.xs;
  } else if (size === "md") {
    sizeStyle = styles.md;
  } else if (size === "lg") {
    sizeStyle = styles.lg;
  } else {
    sizeStyle = styles.sm;
  }
  const triggerStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.base,
      sizeStyle,
      pressed ? styles.pressed : null,
      disabled ? styles.disabled : null,
    ],
    [disabled, sizeStyle],
  );
  const labelStyle = useMemo(() => [styles.label, size === "xs" && styles.labelXs], [size]);

  return (
    <DropdownMenuTrigger {...props} disabled={disabled} style={triggerStyle}>
      {leading}
      <Text style={labelStyle} numberOfLines={1}>
        {children}
      </Text>
      <View style={styles.chevron}>
        <ThemedChevronDown size={buttonIconSize[size]} uniProps={chevronColorMapping} />
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
    xs: geometry.buttonXs,
    sm: geometry.buttonSm,
    md: geometry.buttonMd,
    lg: geometry.buttonLg,
    pressed: {
      opacity: 0.85,
    },
    disabled: {
      opacity: theme.opacity[50],
    },
    label: {
      flexShrink: 1,
      color: theme.colors.foreground,
      ...geometry.buttonText,
    },
    labelXs: geometry.buttonTextXs,
    chevron: {
      transform: [{ translateY: 1 }],
    },
  };
});
