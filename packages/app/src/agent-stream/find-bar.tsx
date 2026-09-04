import { ChevronDown, ChevronUp, X } from "lucide-react-native";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedFindInput = withUnistyles(TextInput);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedXIcon = withUnistyles(X);

const iconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const inputColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

const iconButtonStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  styles.iconButton,
  hovered ? styles.iconButtonHovered : null,
  pressed ? styles.iconButtonPressed : null,
];

const disabledIconButtonStyle = () => [styles.iconButton, styles.iconButtonDisabled];

export interface SessionFindBarProps {
  query: string;
  matchCount: number;
  /** 1-based position of the active match; 0 when there is none. */
  activeMatchNumber: number;
  /** Bump to focus the input (and select its text) again. */
  focusRequestId: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function SessionFindBar({
  query,
  matchCount,
  activeMatchNumber,
  focusRequestId,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: SessionFindBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (isWeb) {
      // On web the TextInput ref is the underlying input element; selecting
      // the previous query lets a repeated Cmd+F overwrite it directly.
      (input as unknown as { select?: () => void }).select?.();
    }
  }, [focusRequestId]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (key === "Enter") {
        const shiftKey = Boolean(
          (event.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean }).shiftKey,
        );
        if (shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
        return;
      }
      if (key === "Escape") {
        onClose();
      }
    },
    [onClose, onNext, onPrevious],
  );

  const hasMatches = matchCount > 0;

  return (
    <View style={styles.bar} testID="session-find-bar">
      <ThemedFindInput
        ref={inputRef}
        // @ts-expect-error - outlineStyle is web-only
        style={[styles.input, isWeb && { outlineStyle: "none" }]}
        uniProps={inputColorMapping}
        value={query}
        onChangeText={onQueryChange}
        onKeyPress={handleKeyPress}
        placeholder={t("agentStream.find.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        testID="session-find-input"
      />
      {query.length > 0 ? (
        <Text style={styles.count} testID="session-find-count">
          {t("agentStream.find.matchCount", {
            current: activeMatchNumber,
            total: matchCount,
          })}
        </Text>
      ) : null}
      <Pressable
        style={hasMatches ? iconButtonStyle : disabledIconButtonStyle}
        onPress={onPrevious}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.find.previous")}
        testID="session-find-previous"
      >
        <ThemedChevronUp size={14} uniProps={iconColorMapping} />
      </Pressable>
      <Pressable
        style={hasMatches ? iconButtonStyle : disabledIconButtonStyle}
        onPress={onNext}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.find.next")}
        testID="session-find-next"
      >
        <ThemedChevronDown size={14} uniProps={iconColorMapping} />
      </Pressable>
      <Pressable
        style={iconButtonStyle}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.find.close")}
        testID="session-find-close"
      >
        <ThemedXIcon size={14} uniProps={iconColorMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.sm,
  },
  input: {
    width: 200,
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonPressed: {
    opacity: 0.9,
  },
  iconButtonDisabled: {
    opacity: theme.opacity[50],
  },
}));
