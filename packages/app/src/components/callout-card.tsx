import { X } from "lucide-react-native";
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export type CalloutActionVariant = "primary" | "secondary";

export interface CalloutAction {
  label: string;
  onPress: () => void;
  variant?: CalloutActionVariant;
  disabled?: boolean;
  testID?: string;
}

export type CalloutVariant = "default" | "success" | "error";

export interface CalloutCardProps {
  title?: string;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: CalloutVariant;
  actions?: readonly CalloutAction[];
  onDismiss?: () => void;
  testID?: string;
}

export function CalloutDescriptionText({ children }: { children: ReactNode }) {
  return <Text style={styles.description}>{children}</Text>;
}

export function CalloutCard({
  title,
  description,
  icon,
  variant = "default",
  actions,
  onDismiss,
  testID,
}: CalloutCardProps) {
  const { theme } = useUnistyles();
  const visibleActions = (actions ?? []).slice(0, 2);
  const hasHeader = title != null || icon != null;
  const hasDescription = description != null && description !== "";

  const containerStyle = useMemo(
    () => [styles.container, variant === "error" ? styles.containerError : null],
    [variant],
  );

  return (
    <View style={containerStyle} testID={testID} accessibilityRole="alert">
      <View style={styles.body}>
        {hasHeader || onDismiss ? (
          <View style={styles.topRow}>
            {hasHeader ? (
              <View style={styles.header}>
                {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
                {title ? (
                  <Text style={styles.title} numberOfLines={2}>
                    {title}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {onDismiss ? (
              <Pressable
                onPress={onDismiss}
                hitSlop={8}
                style={styles.dismissButton}
                testID={testID ? `${testID}-dismiss` : undefined}
                accessibilityLabel="Dismiss"
                accessibilityRole="button"
              >
                {({ hovered }) => (
                  <X
                    size={14}
                    color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                )}
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {hasDescription ? (
          typeof description === "string" ? (
            <CalloutDescriptionText>{description}</CalloutDescriptionText>
          ) : (
            <View style={styles.descriptionSlot}>{description}</View>
          )
        ) : null}

        {visibleActions.length > 0 ? (
          <View style={styles.actionRow} testID={testID ? `${testID}-actions` : undefined}>
            {visibleActions.map((action, index) => (
              <CalloutActionButton
                key={`${action.label}-${index}`}
                action={action}
                testID={action.testID ?? (testID ? `${testID}-action-${index}` : undefined)}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CalloutActionButton({ action, testID }: { action: CalloutAction; testID?: string }) {
  const isPrimary = action.variant === "primary";
  const labelStyle = useMemo(
    () => [styles.actionLabel, isPrimary ? styles.actionLabelPrimary : styles.actionLabelSecondary],
    [isPrimary],
  );
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.actionButton,
        isPrimary ? styles.actionButtonPrimary : styles.actionButtonSecondary,
        pressed ? styles.actionButtonPressed : null,
        action.disabled ? styles.actionButtonDisabled : null,
      ]}
    >
      <Text style={labelStyle} numberOfLines={1}>
        {action.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  containerError: {
    borderTopColor: theme.colors.destructive,
  },
  dismissButton: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    gap: theme.spacing[2],
  },
  topRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  header: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
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
  actionRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  actionButtonSecondary: {
    backgroundColor: "transparent",
    borderColor: theme.colors.border,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  actionLabelPrimary: {
    color: theme.colors.surface0,
  },
  actionLabelSecondary: {
    color: theme.colors.foreground,
  },
}));
