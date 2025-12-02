import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AlertTriangle, CheckCircle2, Info, RefreshCcw, RotateCcw, WifiOff, X } from "lucide-react-native";

export type DictationToastVariant = "info" | "success" | "warning" | "error";

interface DictationStatusNoticeProps {
  variant: DictationToastVariant;
  title: string;
  subtitle?: string;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const variantIconMap: Record<DictationToastVariant, typeof Info> = {
  info: RefreshCcw,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertTriangle,
};

export function DictationStatusNotice({
  variant,
  title,
  subtitle,
  meta,
  actionLabel,
  onAction,
  onDismiss,
}: DictationStatusNoticeProps) {
  const { theme } = useUnistyles();

  const VariantIcon = (() => {
    if (variant === "warning" && title.toLowerCase().includes("offline")) {
      return WifiOff;
    }
    return variantIconMap[variant] ?? Info;
  })();

  const backgroundColor = (() => {
    switch (variant) {
      case "success":
        return theme.colors.palette.green[500];
      case "warning":
        return theme.colors.palette.amber[500];
      case "error":
        return theme.colors.palette.red[500];
      default:
        return theme.colors.background;
    }
  })();

  const foregroundColor = variant === "info" ? theme.colors.foreground : theme.colors.palette.white;
  const secondaryColor = variant === "info" ? theme.colors.mutedForeground : theme.colors.palette.white;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor,
          borderColor: variant === "info" ? theme.colors.border : "transparent",
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <VariantIcon size={16} color={foregroundColor} />
          <Text style={[styles.title, { color: foregroundColor }]}>{title}</Text>
        </View>
        {onDismiss ? (
          <Pressable accessibilityLabel="Dismiss dictation status" hitSlop={8} onPress={onDismiss}>
            <X size={14} color={foregroundColor} />
          </Pressable>
        ) : null}
      </View>

      {subtitle ? (
        <Text style={[styles.subtitle, { color: secondaryColor }]}>{subtitle}</Text>
      ) : null}

      {(meta || (actionLabel && onAction)) && (
        <View style={styles.actionsRow}>
          {meta ? (
            <Text style={[styles.meta, { color: secondaryColor }]}>{meta}</Text>
          ) : (
            <View />
          )}
          {actionLabel && onAction ? (
            <Pressable
              style={[
                styles.actionButton,
                {
                  backgroundColor: variant === "info" ? theme.colors.primary : "rgba(0,0,0,0.2)",
                },
              ]}
              onPress={onAction}
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
            >
              <RotateCcw
                size={14}
                color={variant === "info" ? theme.colors.primaryForeground : foregroundColor}
              />
              <Text
                style={[
                  styles.actionText,
                  { color: variant === "info" ? theme.colors.primaryForeground : foregroundColor },
                ]}
              >
                {actionLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.borderRadius.xl,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  meta: {
    fontSize: theme.fontSize.xs,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  actionText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
}));
