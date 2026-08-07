import { useCallback, useMemo } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface TerminalPasteActionProps {
  hasClipboardText: boolean;
  onPaste: () => void;
}

export function TerminalPasteAction({ hasClipboardText, onPaste }: TerminalPasteActionProps) {
  return (
    <TerminalActionButton
      label="Paste"
      accessibilityLabel="Paste"
      testID="terminal-paste"
      disabled={!hasClipboardText}
      onPress={onPaste}
      variant="key"
    />
  );
}

export interface TerminalFloatingCopyActionProps {
  hasSelection: boolean;
  onCopy: () => void;
}

export function TerminalFloatingCopyAction({
  hasSelection,
  onCopy,
}: TerminalFloatingCopyActionProps) {
  if (!hasSelection) {
    return null;
  }

  return (
    <TerminalActionButton
      label="Copy"
      accessibilityLabel="Copy"
      testID="terminal-copy"
      onPress={onCopy}
      variant="floating"
    />
  );
}

interface TerminalActionButtonProps {
  label: string;
  accessibilityLabel: string;
  testID: string;
  disabled?: boolean;
  onPress: () => void;
  variant: "key" | "floating";
}

function TerminalActionButton({
  label,
  accessibilityLabel,
  testID,
  disabled = false,
  onPress,
  variant,
}: TerminalActionButtonProps) {
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      variant === "floating" ? styles.floatingButton : styles.keyButton,
      disabled && styles.keyButtonDisabled,
      (Boolean(hovered) || pressed) &&
        !disabled &&
        (variant === "floating" ? styles.floatingButtonHovered : styles.keyButtonHovered),
    ],
    [disabled, variant],
  );
  const textStyle = useMemo(
    () => [variant === "floating" ? styles.floatingButtonText : styles.keyButtonText],
    [variant],
  );
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);

  const handlePress = useCallback(() => {
    if (!disabled) {
      onPress();
    }
  }, [disabled, onPress]);

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      testID={testID}
      onPress={handlePress}
      style={pressableStyle}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  keyButton: {
    flex: 1,
    minWidth: 0,
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  keyButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  keyButtonDisabled: {
    opacity: 0.45,
  },
  keyButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  floatingButton: {
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: "rgba(32, 32, 32, 0.86)",
  },
  floatingButtonHovered: {
    backgroundColor: "rgba(48, 48, 48, 0.92)",
  },
  floatingButtonText: {
    color: "#f5f5f5",
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
}));
