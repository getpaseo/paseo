import type { RefObject } from "react";
import { useCallback } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type ViewStyle,
} from "react-native";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { FindResult } from "@/find/engine";
import type { Theme } from "@/styles/theme";

const ThemedSearch = withUnistyles(Search);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

/** react-native-web forwards the DOM keydown modifiers on the key-press event. */
type FindKeyPressEvent = NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean }>;

export interface FindBarProps {
  query: string;
  result: FindResult;
  inputRef: RefObject<EditingTextInputHandle | null>;
  onChangeQuery: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /** Offsets the overlay when the pane has chrome of its own above the content. */
  style?: StyleProp<ViewStyle>;
}

/**
 * The find bar, overlaid at the top-right of the pane it searches.
 *
 * It floats rather than taking layout space: the terminal must not refit and the
 * transcript must not reflow when it opens.
 */
export function FindBar({
  query,
  result,
  inputRef,
  onChangeQuery,
  onNext,
  onPrevious,
  onClose,
  style,
}: FindBarProps) {
  const { t } = useTranslation();
  const nextKeys = useShortcutKeys("find-next");
  const previousKeys = useShortcutKeys("find-previous");
  const hasMatches = result.count > 0;

  // A button press moves focus to the button, and Enter would stop stepping matches.
  const refocusInput = useCallback(() => inputRef.current?.focus(), [inputRef]);

  const handleNext = useCallback(() => {
    onNext();
    refocusInput();
  }, [onNext, refocusInput]);

  const handlePrevious = useCallback(() => {
    onPrevious();
    refocusInput();
  }, [onPrevious, refocusInput]);

  const handleKeyPress = useCallback(
    (event: FindKeyPressEvent) => {
      const { key, shiftKey } = event.nativeEvent;
      if (key === "Enter") {
        event.preventDefault();
        if (shiftKey === true) onPrevious();
        else onNext();
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    // The outer view spans the pane so the bar can be capped at the pane width minus
    // its own insets; `box-none` keeps the empty span from swallowing clicks meant
    // for the surface underneath.
    <View style={[styles.overlay, style]} pointerEvents="box-none">
      <View style={styles.bar} testID="find-bar">
        <ThemedSearch size={14} uniProps={mutedIconColorMapping} />
        <ThemedTextInput
          ref={inputRef}
          testID="find-bar-input"
          initialValue={query}
          onChangeText={onChangeQuery}
          onKeyPress={handleKeyPress}
          placeholder={t("find.placeholder")}
          accessibilityLabel={t("find.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Text style={styles.count} numberOfLines={1} testID="find-bar-count">
          {findCountLabel({ query, result, t })}
        </Text>
        <ToolbarButton
          compact
          label={t("find.previous")}
          shortcut={previousKeys}
          disabled={!hasMatches}
          onPress={handlePrevious}
          testID="find-bar-previous"
        >
          <ThemedChevronUp size={14} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
        <ToolbarButton
          compact
          label={t("find.next")}
          shortcut={nextKeys}
          disabled={!hasMatches}
          onPress={handleNext}
          testID="find-bar-next"
        >
          <ThemedChevronDown size={14} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
        <ToolbarButton compact label={t("find.close")} onPress={onClose} testID="find-bar-close">
          <ThemedX size={14} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
      </View>
    </View>
  );
}

/** Exported for its own unit test; the bar itself is the only other caller. */
export function findCountLabel(input: {
  query: string;
  result: FindResult;
  t: (key: string, options?: Record<string, number>) => string;
}): string {
  const { query, result, t } = input;
  if (query === "") {
    return "";
  }
  if (result.count === 0) {
    return t("find.noResults");
  }
  if (result.activeIndex === null && result.countIsCapped === true) {
    // A capped engine knows neither the total nor where the active match sits in it, so
    // there is no position to name. Saying "1 of 1000" would name the wrong one forever.
    return t("find.cappedCount", { count: result.count });
  }
  // An engine may report matches before it has activated one; the counter still names
  // the match the next Enter lands on.
  return t("find.matchPosition", { current: (result.activeIndex ?? 0) + 1, count: result.count });
}

const FIND_BAR_WIDTH = 320;

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 1,
    alignItems: "flex-end",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    width: FIND_BAR_WIDTH,
    maxWidth: "100%",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 24,
    // The pane's own border already frames the bar; a browser focus ring inside it
    // would sit on top of that. `outlineWidth` is a no-op on native.
    outlineWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  count: {
    // Fixed so "12 of 340" and "No results" never move the buttons.
    minWidth: 72,
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
