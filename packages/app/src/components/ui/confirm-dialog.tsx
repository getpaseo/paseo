import { useEffect } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses the destructive (red) style. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isPending?: boolean;
}

/**
 * Themed confirmation modal — replaces the native `window.confirm` for
 * destructive actions like deleting a channel. Centers a card with a title,
 * optional description, and Cancel / Confirm buttons. Esc + scrim click
 * cancels.
 */
export function ConfirmDialog({
  visible,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  onCancel,
  isPending,
}: ConfirmDialogProps) {
  const { theme } = useUnistyles();

  useEffect(() => {
    if (!visible || !isWeb || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && !isPending) onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onCancel, onConfirm, isPending]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityLabel="Dismiss dialog">
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <View style={styles.buttonRow}>
            <Pressable
              onPress={onCancel}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
              style={({ hovered, pressed }) => [
                styles.cancelButton,
                hovered && styles.cancelButtonHover,
                pressed && styles.cancelButtonPressed,
              ]}
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              style={({ hovered, pressed }) => [
                styles.confirmButton,
                destructive ? styles.confirmButtonDestructive : styles.confirmButtonPrimary,
                hovered &&
                  (destructive
                    ? styles.confirmButtonDestructiveHover
                    : styles.confirmButtonPrimaryHover),
                pressed && styles.confirmButtonPressed,
                isPending && styles.confirmButtonDisabled,
              ]}
            >
              <Text style={styles.confirmText}>{isPending ? "…" : confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
  // `theme` is referenced to keep the hook call non-trivial for Unistyles reactivity.
  void theme;
}

const styles = StyleSheet.create((theme) => ({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    ...(isWeb ? ({ backdropFilter: "blur(4px)" } as Record<string, unknown>) : {}),
  },
  card: {
    width: "100%",
    maxWidth: 400,
    padding: theme.spacing[6],
    borderRadius: 16,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 20,
    gap: theme.spacing[2],
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.foreground,
    letterSpacing: -0.2,
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  cancelButton: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2] + 2,
    borderRadius: 999,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cancelButtonHover: {
    backgroundColor: theme.colors.surface3,
  },
  cancelButtonPressed: {
    opacity: 0.85,
  },
  cancelText: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  confirmButton: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2] + 2,
    borderRadius: 999,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmButtonPrimary: {
    backgroundColor: theme.colors.brandMagenta,
  },
  confirmButtonPrimaryHover: {
    backgroundColor: theme.colors.brandMagentaHover,
  },
  confirmButtonDestructive: {
    backgroundColor: theme.colors.destructive,
  },
  confirmButtonDestructiveHover: {
    opacity: 0.9,
  },
  confirmButtonPressed: {
    opacity: 0.9,
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
  },
}));
