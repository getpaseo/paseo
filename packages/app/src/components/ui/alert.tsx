import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export type AlertVariant = "default" | "info" | "success" | "warning" | "error";

export interface AlertProps {
  title?: string;
  description?: ReactNode;
  variant?: AlertVariant;
  icon?: ReactNode;
  children?: ReactNode;
  testID?: string;
}

const VARIANT_ICON: Record<Exclude<AlertVariant, "default">, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

export function Alert({
  title,
  description,
  variant = "default",
  icon,
  children,
  testID,
}: AlertProps) {
  const { theme } = useUnistyles();
  const accentColor = resolveAccentColor(variant, theme);

  const containerStyle = useMemo(
    () => [styles.container, accentColor ? { borderColor: accentColor } : null],
    [accentColor],
  );

  const titleStyle = useMemo(
    () => [styles.title, accentColor ? { color: accentColor } : null],
    [accentColor],
  );

  const resolvedIcon = useMemo(() => {
    if (icon !== undefined) return icon;
    if (variant === "default") return null;
    const Icon = VARIANT_ICON[variant];
    return <Icon size={theme.iconSize.sm} color={accentColor ?? theme.colors.foreground} />;
  }, [icon, variant, theme, accentColor]);

  const hasDescription = description != null && description !== "";

  return (
    <View style={containerStyle} testID={testID} accessibilityRole="alert">
      {resolvedIcon ? <View style={styles.iconSlot}>{resolvedIcon}</View> : null}
      <View style={styles.body}>
        {title ? <Text style={titleStyle}>{title}</Text> : null}
        {hasDescription && typeof description === "string" ? (
          <Text style={styles.description}>{description}</Text>
        ) : null}
        {hasDescription && typeof description !== "string" ? (
          <View style={styles.descriptionSlot}>{description}</View>
        ) : null}
        {children ? <View style={styles.actions}>{children}</View> : null}
      </View>
    </View>
  );
}

function resolveAccentColor(
  variant: AlertVariant,
  theme: ReturnType<typeof useUnistyles>["theme"],
): string | null {
  if (variant === "info") return theme.colors.palette.blue[300];
  if (variant === "success") return theme.colors.palette.green[400];
  if (variant === "warning") return theme.colors.palette.amber[500];
  if (variant === "error") return theme.colors.destructive;
  return null;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.xl,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  iconSlot: {
    paddingTop: 2,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  descriptionSlot: {
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
