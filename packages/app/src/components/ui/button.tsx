import { useState, type ComponentType, type PropsWithChildren, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import type { PressableProps, StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

type LeftIcon =
  | ReactElement
  | ComponentType<{ color: string; size: number }>
  | ((color: string) => ReactElement)
  | null;

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 20 };

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
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  secondary: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.surface3,
  },
  outline: {
    backgroundColor: "transparent",
    borderColor: theme.colors.borderAccent,
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
    fontWeight: theme.fontWeight.normal,
  },
  textDefault: {
    color: theme.colors.palette.white,
  },
  textDestructive: {
    color: theme.colors.palette.white,
  },
  textGhost: {
    color: theme.colors.foregroundMuted,
  },
  textGhostHovered: {
    color: theme.colors.foreground,
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
    leftIcon?: LeftIcon;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
  }
>) {
  const [hovered, setHovered] = useState(false);
  const { theme } = useUnistyles();

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
  const isGhostHovered = hovered && variant === "ghost";

  const resolvedTextStyle = [
    styles.text,
    variant === "default" ? styles.textDefault : null,
    variant === "destructive" ? styles.textDestructive : null,
    variant === "ghost" ? styles.textGhost : null,
    textStyle,
    isGhostHovered ? styles.textGhostHovered : null,
  ];

  function renderIcon() {
    if (!leftIcon) return null;

    // Pre-rendered element — pass through
    if (typeof leftIcon === "object" && "type" in leftIcon) {
      return <View>{leftIcon}</View>;
    }

    const color =
      variant === "default"
        ? theme.colors.accentForeground
        : variant === "ghost"
          ? isGhostHovered
            ? theme.colors.foreground
            : theme.colors.foregroundMuted
          : theme.colors.foreground;
    const iconSize = ICON_SIZE[size];

    // Render function
    if (
      typeof leftIcon === "function" &&
      !leftIcon.prototype?.isReactComponent &&
      leftIcon.length > 0
    ) {
      return <View>{(leftIcon as (color: string) => ReactElement)(color)}</View>;
    }

    // Component type
    const Icon = leftIcon as ComponentType<{ color: string; size: number }>;
    return (
      <View>
        <Icon color={color} size={iconSize} />
      </View>
    );
  }

  return (
    <Pressable
      {...props}
      accessibilityRole={accessibilityRole ?? "button"}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.base,
        sizeStyle,
        variantStyle,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      {renderIcon()}
      {children != null ? <Text style={resolvedTextStyle}>{children}</Text> : null}
    </Pressable>
  );
}
