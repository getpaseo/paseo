import {
  default as React,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type {
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "xs" | "sm" | "md" | "lg";

type LeftIcon =
  | ReactElement
  | ComponentType<{ color: string; size: number }>
  | ((color: string) => ReactElement)
  | null;

const ICON_SIZE: Record<ButtonSize, number> = { xs: 12, sm: 14, md: 16, lg: 20 };

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
  xs: {
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
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
  textXs: {
    fontSize: theme.fontSize.xs,
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
  trailing,
  style,
  textStyle,
  disabled,
  loading = false,
  accessibilityRole,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    leftIcon?: LeftIcon;
    trailing?: ReactNode;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
    loading?: boolean;
  }
>) {
  const [hovered, setHovered] = useState(false);
  const { theme } = useUnistyles();
  const isDisabled = disabled || loading;

  let variantStyle: ViewStyle;
  if (variant === "default") {
    variantStyle = styles.default;
  } else if (variant === "secondary") {
    variantStyle = styles.secondary;
  } else if (variant === "outline") {
    variantStyle = styles.outline;
  } else if (variant === "ghost") {
    variantStyle = styles.ghost;
  } else {
    variantStyle = styles.destructive;
  }

  let sizeStyle: ViewStyle;
  if (size === "xs") {
    sizeStyle = styles.xs;
  } else if (size === "sm") {
    sizeStyle = styles.sm;
  } else if (size === "lg") {
    sizeStyle = styles.lg;
  } else {
    sizeStyle = styles.md;
  }
  const isGhostHovered = hovered && variant === "ghost";

  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
      styles.base,
      sizeStyle,
      variantStyle,
      pressed ? styles.pressed : null,
      isDisabled ? styles.disabled : null,
      style,
    ],
    [sizeStyle, variantStyle, isDisabled, style],
  );

  const resolvedTextStyle = useMemo(
    () => [
      styles.text,
      size === "xs" ? styles.textXs : null,
      variant === "default" ? styles.textDefault : null,
      variant === "destructive" ? styles.textDestructive : null,
      variant === "ghost" ? styles.textGhost : null,
      textStyle,
      isGhostHovered ? styles.textGhostHovered : null,
    ],
    [size, variant, textStyle, isGhostHovered],
  );

  const accessibilityState = useMemo(
    () => ({ disabled: isDisabled, busy: loading }),
    [isDisabled, loading],
  );

  function resolveIconColor(): string {
    if (variant === "default") {
      return theme.colors.accentForeground;
    }
    if (variant === "ghost") {
      return isGhostHovered ? theme.colors.foreground : theme.colors.foregroundMuted;
    }
    return theme.colors.foreground;
  }

  function renderIcon() {
    if (loading) {
      return (
        <View>
          <ActivityIndicator size="small" color={resolveIconColor()} />
        </View>
      );
    }

    if (!leftIcon) return null;

    // Pre-rendered element — pass through
    if (typeof leftIcon === "object" && "type" in leftIcon) {
      return <View>{leftIcon}</View>;
    }

    const color = resolveIconColor();
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
      accessibilityState={accessibilityState}
      disabled={isDisabled}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={pressableStyle}
    >
      {renderIcon()}
      {children != null ? <Text style={resolvedTextStyle}>{children}</Text> : null}
      {trailing}
    </Pressable>
  );
}
