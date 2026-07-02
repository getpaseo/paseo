import { useCallback, useMemo, type RefObject } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputKeyPressEventData,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import type { Theme } from "@/styles/theme";

const ThemedCaseSensitive = withUnistyles(CaseSensitive);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

type FindBarKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    // Web-only: RNW forwards the DOM KeyboardEvent modifier/composition state.
    shiftKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  }
>;

// Keep DOM focus in the query input when the nav buttons are clicked so
// Escape-to-close and continued typing keep working (web only; press events
// still fire with the mousedown default prevented).
// Vertical slop reaches the 44pt native target guidance; horizontal slop is
// capped at half the 4px button gap so adjacent buttons' hit rects never
// overlap a neighbor's visible face (native hit-testing lets a later sibling's
// slop win over an earlier sibling's real bounds).
const FIND_BUTTON_HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 2 } as const;

const FOCUS_RETENTION_PROPS = isWeb
  ? ({
      onMouseDown: (event: { preventDefault?: () => void }) => {
        event.preventDefault?.();
      },
    } as const)
  : undefined;

export interface FileFindBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  matchCount: number;
  /** 0-based index of the active match; ignored when matchCount is 0. */
  activeIndex: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  inputRef: RefObject<TextInput | null>;
  /**
   * Full-width row pinned above the code (compact layouts) instead of the
   * floating top-right overlay used on desktop.
   */
  docked: boolean;
}

function iconButtonStyle(
  state: PressableStateCallbackType,
  disabled: boolean,
): StyleProp<ViewStyle> {
  return [
    styles.iconButton,
    (state.hovered || state.pressed) && !disabled && styles.iconButtonHovered,
    disabled && styles.iconButtonDisabled,
  ];
}

function enabledIconButtonStyle(state: PressableStateCallbackType): StyleProp<ViewStyle> {
  return iconButtonStyle(state, false);
}

function formatMatchCount(input: {
  query: string;
  matchCount: number;
  activeIndex: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (input.query.length === 0) {
    return "";
  }
  if (input.matchCount === 0) {
    return input.t("panels.file.find.noResults");
  }
  return input.t("panels.file.find.matchCount", {
    current: input.activeIndex + 1,
    total: input.matchCount,
  });
}

export function FileFindBar({
  query,
  onQueryChange,
  caseSensitive,
  onToggleCaseSensitive,
  matchCount,
  activeIndex,
  onNext,
  onPrevious,
  onClose,
  inputRef,
  docked,
}: FileFindBarProps) {
  const { t } = useTranslation();
  const navigationDisabled = matchCount === 0;

  const containerStyle = useMemo(
    () => [styles.container, docked ? styles.containerDocked : styles.containerFloating],
    [docked],
  );
  const inputRegionStyle = useMemo(
    () => [styles.inputRegion, docked && styles.inputRegionDocked],
    [docked],
  );

  const handleKeyPress = useCallback(
    (event: FindBarKeyPressEvent) => {
      // During IME composition Escape dismisses the candidate window and Enter
      // confirms it; neither may drive the find bar.
      if (isImeComposingKeyboardEvent(event.nativeEvent)) {
        return;
      }
      const key = event.nativeEvent.key;
      if (key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      // Plain Enter submits through onSubmitEditing; only reverse needs a hook.
      if (key === "Enter" && event.nativeEvent.shiftKey === true) {
        event.preventDefault();
        onPrevious();
      }
    },
    [onClose, onPrevious],
  );

  const navigationButtonStyle = useCallback(
    (state: PressableStateCallbackType) => iconButtonStyle(state, navigationDisabled),
    [navigationDisabled],
  );

  const caseToggleStyle = useCallback(
    (state: PressableStateCallbackType) => [
      iconButtonStyle(state, false),
      caseSensitive && styles.iconButtonActive,
    ],
    [caseSensitive],
  );
  const caseToggleAccessibilityState = useMemo(
    () => ({ selected: caseSensitive }),
    [caseSensitive],
  );

  return (
    <View style={containerStyle} testID="file-pane-find-bar">
      <View style={inputRegionStyle}>
        <ThemedTextInput
          ref={inputRef}
          value={query}
          onChangeText={onQueryChange}
          onKeyPress={handleKeyPress}
          onSubmitEditing={onNext}
          blurOnSubmit={false}
          placeholder={t("panels.file.find.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          selectTextOnFocus
          returnKeyType="search"
          // @ts-expect-error - outlineStyle is web-only
          style={FIND_INPUT_STYLE}
          accessibilityLabel={t("panels.file.find.placeholder")}
          testID="file-pane-find-input"
        />
        <Text numberOfLines={1} style={styles.matchCount}>
          {formatMatchCount({ query, matchCount, activeIndex, t })}
        </Text>
      </View>
      <Pressable
        hitSlop={FIND_BUTTON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.find.matchCase")}
        accessibilityState={caseToggleAccessibilityState}
        onPress={onToggleCaseSensitive}
        style={caseToggleStyle}
        testID="file-pane-find-match-case"
        {...FOCUS_RETENTION_PROPS}
      >
        <ThemedCaseSensitive
          size={16}
          uniProps={caseSensitive ? foregroundColorMapping : foregroundMutedColorMapping}
        />
      </Pressable>
      <Pressable
        hitSlop={FIND_BUTTON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.find.previousMatch")}
        disabled={navigationDisabled}
        onPress={onPrevious}
        style={navigationButtonStyle}
        testID="file-pane-find-previous"
        {...FOCUS_RETENTION_PROPS}
      >
        <ThemedChevronUp size={16} uniProps={foregroundMutedColorMapping} />
      </Pressable>
      <Pressable
        hitSlop={FIND_BUTTON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.find.nextMatch")}
        disabled={navigationDisabled}
        onPress={onNext}
        style={navigationButtonStyle}
        testID="file-pane-find-next"
        {...FOCUS_RETENTION_PROPS}
      >
        <ThemedChevronDown size={16} uniProps={foregroundMutedColorMapping} />
      </Pressable>
      <Pressable
        hitSlop={FIND_BUTTON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.find.close")}
        onPress={onClose}
        style={enabledIconButtonStyle}
        testID="file-pane-find-close"
      >
        <ThemedX size={16} uniProps={foregroundMutedColorMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  containerFloating: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
  },
  containerDocked: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  // Fixed-width region shared by the input and the match counter: the counter
  // borrows typing space when it appears, so the bar itself never resizes.
  inputRegion: {
    width: 232,
    flexDirection: "row",
    alignItems: "center",
  },
  // Docked bars span the pane, so the input region flexes instead.
  inputRegionDocked: {
    width: "auto",
    flex: 1,
    minWidth: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  matchCount: {
    flexShrink: 0,
    maxWidth: 128,
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    userSelect: "none",
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  iconButtonDisabled: {
    opacity: theme.opacity[50],
  },
}));

const FIND_INPUT_STYLE = [styles.input, isWeb && { outlineStyle: "none" }];
