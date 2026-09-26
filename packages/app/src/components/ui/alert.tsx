import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  type ButtonControlSize,
  buttonIconSize,
  createControlGeometry,
} from "@/components/ui/control-geometry";
import { hexColorWithAlpha } from "@/utils/color";

export type AlertVariant = "default" | "info" | "success" | "warning" | "error";
export type AlertSize = ButtonControlSize;

export interface AlertProps {
  title?: string;
  description?: ReactNode;
  variant?: AlertVariant;
  size?: AlertSize;
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
  size = "md",
  children,
  testID,
}: AlertProps) {
  const { theme } = useUnistyles();
  const accentColor = resolveAccentColor(variant, theme);
  const borderColor =
    variant === "success" || !accentColor
      ? theme.colors.border
      : hexColorWithAlpha(accentColor, 0.5);

  const sized = resolveSizeStyles(size);
  const containerStyle = [styles.container, sized.container, { borderColor }];
  const titleStyle = [styles.title, sized.text, accentColor ? { color: accentColor } : null];
  const iconSize = buttonIconSize[size];

  const resolvedIcon = useMemo(() => {
    if (variant === "default") return null;
    const Icon = VARIANT_ICON[variant];
    return <Icon size={iconSize} color={accentColor ?? theme.colors.foreground} />;
  }, [variant, theme, accentColor, iconSize]);

  let descriptionContent: ReactNode = null;
  if (typeof description === "string" && description !== "") {
    descriptionContent = <Text style={[styles.description, sized.text]}>{description}</Text>;
  } else if (description != null && description !== "") {
    descriptionContent = <View style={styles.descriptionSlot}>{description}</View>;
  }
  const leadContent = title ? <Text style={titleStyle}>{title}</Text> : descriptionContent;
  const belowLead = title ? descriptionContent : null;
  const hasBody = belowLead !== null || Boolean(children);

  return (
    <View style={containerStyle} testID={testID} accessibilityRole="alert">
      <View style={[styles.lead, sized.lead]}>
        {resolvedIcon ? (
          <View style={[styles.iconSlot, sized.iconSlot]}>{resolvedIcon}</View>
        ) : null}
        {leadContent ? <View style={styles.leadText}>{leadContent}</View> : null}
      </View>
      {hasBody ? (
        <View style={resolvedIcon ? sized.indent : null}>
          {belowLead}
          {children ? <View style={styles.actions}>{children}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

function resolveSizeStyles(size: AlertSize) {
  if (size === "xs") {
    return {
      container: styles.containerXs,
      text: styles.textXs,
      lead: styles.leadXs,
      iconSlot: styles.iconSlotXs,
      indent: styles.indentXs,
    };
  }
  if (size === "sm") {
    return {
      container: styles.containerSm,
      text: styles.textSm,
      lead: styles.leadSm,
      iconSlot: styles.iconSlotSm,
      indent: styles.indentSm,
    };
  }
  if (size === "lg") {
    return {
      container: styles.containerLg,
      text: styles.textLg,
      lead: styles.leadLg,
      iconSlot: styles.iconSlotLg,
      indent: styles.indentLg,
    };
  }
  return {
    container: styles.containerMd,
    text: styles.textMd,
    lead: styles.leadMd,
    iconSlot: styles.iconSlotMd,
    indent: styles.indentMd,
  };
}

function resolveAccentColor(
  variant: AlertVariant,
  theme: ReturnType<typeof useUnistyles>["theme"],
): string | null {
  if (variant === "info") return theme.colors.palette.blue[300];
  if (variant === "success") return theme.colors.statusSuccess;
  if (variant === "warning") return theme.colors.palette.amber[500];
  if (variant === "error") return theme.colors.destructive;
  return null;
}

const styles = StyleSheet.create((theme) => {
  const { alert } = createControlGeometry(theme);

  return {
    container: {
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      backgroundColor: "transparent",
    },
    containerXs: alert.xs.container,
    containerSm: alert.sm.container,
    containerMd: alert.md.container,
    containerLg: alert.lg.container,
    lead: {
      flexDirection: "row",
      alignItems: "center",
    },
    iconSlot: {
      alignItems: "center",
    },
    leadText: {
      flex: 1,
      minWidth: 0,
    },
    leadXs: alert.xs.lead,
    leadSm: alert.sm.lead,
    leadMd: alert.md.lead,
    leadLg: alert.lg.lead,
    iconSlotXs: alert.xs.iconSlot,
    iconSlotSm: alert.sm.iconSlot,
    iconSlotMd: alert.md.iconSlot,
    iconSlotLg: alert.lg.iconSlot,
    indentXs: alert.xs.indent,
    indentSm: alert.sm.indent,
    indentMd: alert.md.indent,
    indentLg: alert.lg.indent,
    textXs: alert.xs.text,
    textSm: alert.sm.text,
    textMd: alert.md.text,
    textLg: alert.lg.text,
    title: {
      color: theme.colors.foreground,
      fontWeight: theme.fontWeight.medium,
    },
    description: {
      color: theme.colors.foregroundMuted,
      fontWeight: theme.fontWeight.normal,
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
  };
});
