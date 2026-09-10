import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

const TextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export interface PaneFindHandle {
  focus(): void;
}

export interface PaneFindProps {
  query: string;
  status: string;
  canNavigate: boolean;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
  replace?: {
    value: string;
    onChange(value: string): void;
    onReplace(): void;
    onReplaceAll(): void;
  };
}

/** Pane-local chrome. The content owner supplies search state and commands. */
export const PaneFind = forwardRef<PaneFindHandle, PaneFindProps>(function PaneFind(
  { query, status, canNavigate, onQueryChange, onNext, onPrevious, onClose, replace },
  ref,
) {
  const { t } = useTranslation();
  const input = useRef<EditingTextInputHandle>(null);
  const replacementInput = useRef<EditingTextInputHandle>(null);
  useLayoutEffect(() => {
    if (input.current?.getText() !== query) input.current?.replaceText(query);
  }, [query]);
  useLayoutEffect(() => {
    if (replace && replacementInput.current?.getText() !== replace.value)
      replacementInput.current?.replaceText(replace.value);
  }, [replace]);
  const [replaceExpanded, setReplaceExpanded] = useState(false);
  const focus = useCallback(() => {
    input.current?.focus();
    const text = input.current?.getText() ?? "";
    input.current?.replaceText(text, { start: 0, end: text.length });
  }, []);
  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        altKey?: boolean;
        isComposing?: boolean;
        keyCode?: number;
      };
      if (isImeComposingKeyboardEvent(key)) return;
      if (
        (key.metaKey || key.ctrlKey) &&
        !key.altKey &&
        !key.shiftKey &&
        key.key.toLowerCase() === "f"
      ) {
        // RN Web inputs stop keydown before the pane's document listener.
        event.preventDefault();
        event.stopPropagation();
        focus();
      } else if (key.key === "Escape" || key.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (key.key === "Escape") onClose();
        else if (key.shiftKey) onPrevious();
        else onNext();
      }
    },
    [focus, onClose, onNext, onPrevious],
  );
  const toggleReplace = useCallback(() => setReplaceExpanded((expanded) => !expanded), []);
  const replaceAccessibilityState = useMemo(
    () => ({ expanded: replaceExpanded }),
    [replaceExpanded],
  );

  return (
    <View
      style={styles.widget}
      accessibilityLabel={t("paneFind.title")}
      {...(isWeb
        ? {
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === "Escape" && !isImeComposingKeyboardEvent(event.nativeEvent)) {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            },
          }
        : {})}
    >
      <View style={styles.findRow}>
        <View style={styles.queryRow}>
          {replace ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={replaceExpanded ? ChevronDown : ChevronRight}
              accessibilityLabel={t("paneFind.toggleReplace")}
              accessibilityState={replaceAccessibilityState}
              onPress={toggleReplace}
            />
          ) : null}
          <TextInput
            ref={input}
            autoFocus
            selectTextOnFocus
            initialValue={query}
            onChangeText={onQueryChange}
            onKeyPress={onKeyPress}
            accessibilityLabel={t("paneFind.placeholder")}
            placeholder={t("paneFind.placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            blurOnSubmit={false}
            style={styles.input}
          />
        </View>
        <View style={styles.row}>
          <Text
            style={styles.status}
            role="status"
            accessibilityLabel={t("paneFind.matches")}
            accessibilityLiveRegion="polite"
          >
            {status}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ArrowUp}
            accessibilityLabel={t("paneFind.previous")}
            disabled={!canNavigate}
            onPress={onPrevious}
          />
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ArrowDown}
            accessibilityLabel={t("paneFind.next")}
            disabled={!canNavigate}
            onPress={onNext}
          />
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          accessibilityLabel={t("paneFind.close")}
          onPress={onClose}
        />
      </View>
      {replace && replaceExpanded ? (
        <View style={styles.replacement}>
          <TextInput
            ref={replacementInput}
            initialValue={replace.value}
            onChangeText={replace.onChange}
            onKeyPress={onKeyPress}
            accessibilityLabel={t("paneFind.replaceWith")}
            placeholder={t("paneFind.replaceWith")}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <View style={styles.row}>
            <Button variant="ghost" size="sm" disabled={!canNavigate} onPress={replace.onReplace}>
              {t("paneFind.replace")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canNavigate}
              onPress={replace.onReplaceAll}
            >
              {t("paneFind.replaceAll")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  widget: {
    width: 480,
    maxWidth: "100%",
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  findRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
  queryRow: {
    flex: 1,
    minWidth: 140,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  replacement: { gap: theme.spacing[1] },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: CONTROL_HEIGHTS.compact,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  status: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
  },
}));
