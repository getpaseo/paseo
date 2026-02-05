import type { PropsWithChildren, ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import type { PressableProps, StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

const styles = StyleSheet.create((theme) => ({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: "transparent",
  },
  md: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  sm: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  lg: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
  },
  default: {
    backgroundColor: theme.colors.palette.blue[500],
    borderColor: theme.colors.palette.blue[500],
  },
  secondary: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
  },
  outline: {
    backgroundColor: "transparent",
    borderColor: theme.colors.border,
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
  },
  destructive: {
    backgroundColor: theme.colors.destructive,
    borderColor: theme.colors.destructive,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  textDefault: {
    color: theme.colors.palette.white,
  },
  textDestructive: {
    color: theme.colors.palette.white,
  },
}));

export function Button({
  children,
  variant = "secondary",
  size = "md",
  leftIcon,
  style,
  textStyle,
  disabled,
  accessibilityRole,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    leftIcon?: ReactElement | null;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
  }
>) {
  const variantStyle =
    variant === "default"
      ? styles.default
      : variant === "secondary"
        ? styles.secondary
        : variant === "outline"
          ? styles.outline
          : variant === "ghost"
            ? styles.ghost
            : styles.destructive;

  const sizeStyle = size === "sm" ? styles.sm : size === "lg" ? styles.lg : styles.md;

  const resolvedTextStyle = [
    styles.text,
    variant === "default" ? styles.textDefault : null,
    variant === "destructive" ? styles.textDestructive : null,
    textStyle,
  ];

  return (
    <Pressable
      {...props}
      accessibilityRole={accessibilityRole ?? "button"}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        sizeStyle,
        variantStyle,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      {leftIcon ? <View>{leftIcon}</View> : null}
      <Text style={resolvedTextStyle}>{children}</Text>
    </Pressable>
  );
}
