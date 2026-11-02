import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Text,
  View,
  type AccessibilityActionEvent,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import * as Haptics from "expo-haptics";
import { ChevronsLeftRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { CONTROL_HEIGHTS, type FieldControlSize } from "@/components/ui/control-geometry";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { ICON_SIZE } from "@/styles/theme";
import {
  clampScrubValue,
  createScrubSession,
  isScrubValueInRange,
  stepScrubValue,
  type ScrubFormat,
  type ScrubScale,
  type ScrubSession,
  type ScrubValue,
} from "@/utils/scrub-number";
import { ScrubHandle } from "./scrub-handle";

export interface ScrubNumberFieldProps {
  /** Names the field for assistive tech and in error text. */
  label: string;
  value: ScrubValue;
  onChange: (value: ScrubValue) => void;
  scale: ScrubScale;
  /** Keep it stable (module level): the field re-syncs its text when it changes. */
  format: ScrubFormat;
  /** What a screen reader says for the value; defaults to the formatted text. */
  describeValue?: (value: ScrubValue) => string;
  /** Shown in the empty input of a nullable field. */
  placeholder?: string;
  /** The touch keyboard: "numeric" for whole numbers, "decimal" when a fraction is valid. */
  inputMode?: "numeric" | "decimal";
  disabled?: boolean;
  /** An error from the caller; a typing error of the field's own wins over it. */
  error?: string | null;
  size?: FieldControlSize;
  testID?: string;
}

type DraftError = "invalid" | "range" | null;

/**
 * A number you can type, scrub by dragging the grip sideways, or step with the arrow keys
 * (Shift for the fine step on web). Typed text commits while it is a value inside the range;
 * on blur the text settles back to the committed value. Empty text on a nullable scale is null.
 */
export function ScrubNumberField({
  label,
  value,
  onChange,
  scale,
  format,
  describeValue,
  placeholder,
  inputMode = "decimal",
  disabled = false,
  error,
  size = "md",
  testID,
}: ScrubNumberFieldProps): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const sessionRef = useRef<ScrubSession | null>(null);
  // The last value the drag landed on: valueRef lags behind until the parent re-renders.
  const scrubValueRef = useRef<ScrubValue>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [draftError, setDraftError] = useState<DraftError>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const formatValue = useCallback(
    (next: ScrubValue) => (next === null ? "" : format.format(next)),
    [format],
  );

  // The text follows the value unless you are typing that same value right now.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const text = input.getText();
    if (input.isFocused() && format.parse(text) === value) {
      return;
    }
    const next = formatValue(value);
    if (text !== next) {
      input.replaceText(next);
    }
  }, [format, formatValue, value]);

  const commit = useCallback(
    (next: ScrubValue) => {
      setDraftError(null);
      if (next !== valueRef.current) {
        onChange(next);
      }
    },
    [onChange],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      const parsed = format.parse(text);
      if (parsed === undefined) {
        setDraftError("invalid");
        return;
      }
      if (parsed === null) {
        if (scale.nullable) {
          commit(null);
        } else {
          setDraftError(null);
        }
        return;
      }
      if (!isScrubValueInRange(scale, parsed)) {
        setDraftError("range");
        return;
      }
      commit(parsed);
    },
    [commit, format, scale],
  );

  const handleBlur = useCallback(() => {
    const input = inputRef.current;
    const parsed = input ? format.parse(input.getText()) : undefined;
    const settled = typeof parsed === "number" ? clampScrubValue(scale, parsed) : valueRef.current;
    commit(settled);
    input?.replaceText(formatValue(settled));
  }, [commit, format, formatValue, scale]);

  const handleSubmitEditing = useCallback(() => inputRef.current?.blur(), []);

  const step = useCallback(
    (notches: number, fine: boolean) => {
      commit(stepScrubValue(scale, valueRef.current, notches, fine));
    },
    [commit, scale],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (key !== "ArrowUp" && key !== "ArrowDown") {
        return;
      }
      // Web only: native keyboards have no arrow keys, and only web reports Shift here.
      const fine = (event.nativeEvent as { shiftKey?: boolean }).shiftKey === true;
      event.preventDefault();
      step(key === "ArrowUp" ? 1 : -1, fine);
    },
    [step],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "increment") {
        step(1, false);
      } else if (event.nativeEvent.actionName === "decrement") {
        step(-1, false);
      }
    },
    [step],
  );

  const handleScrubStart = useCallback(() => {
    // A drag starts from the committed value, not from half-typed text.
    inputRef.current?.replaceText(formatValue(valueRef.current));
    sessionRef.current = createScrubSession(scale, valueRef.current);
    scrubValueRef.current = valueRef.current;
    setDraftError(null);
    setScrubbing(true);
  }, [formatValue, scale]);

  const handleScrubMove = useCallback(
    (deltaPx: number, fine: boolean) => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      const next = session.move(deltaPx, fine);
      if (next !== scrubValueRef.current) {
        scrubValueRef.current = next;
        // One tick per value the drag lands on, as on a picker wheel; none past the range ends.
        if (isNative) {
          void Haptics.selectionAsync().catch(() => {});
        }
      }
      commit(next);
    },
    [commit],
  );

  const handleScrubEnd = useCallback(() => {
    sessionRef.current = null;
    setScrubbing(false);
  }, []);

  const accessibilityActions = useMemo(
    () => [
      { name: "increment", label: t("goals.form.increase", { label }) },
      { name: "decrement", label: t("goals.form.decrease", { label }) },
    ],
    [label, t],
  );
  const shownError = errorText(t, draftError, scale, format) ?? error ?? null;
  const valueText = describeValue ? describeValue(value) : formatValue(value) || placeholder || "";

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.row}>
        <ScrubHandle
          disabled={disabled}
          onScrubStart={handleScrubStart}
          onScrubMove={handleScrubMove}
          onScrubEnd={handleScrubEnd}
          accessibilityLabel={label}
          accessibilityHint={t("goals.form.numberField.dragHint")}
          accessibilityValueText={valueText}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={handleAccessibilityAction}
          style={[
            styles.handle,
            styles[HANDLE_SIZE_STYLE[size]],
            scrubbing && styles.handleActive,
            disabled && styles.disabled,
          ]}
          testID={testID ? `${testID}-handle` : undefined}
        >
          <ChevronsLeftRight
            size={ICON_SIZE.md}
            color={scrubbing ? styles.iconActive.color : styles.icon.color}
          />
        </ScrubHandle>
        <View style={[styles.inputBox, shownError ? styles.inputBoxError : null]}>
          <FormTextInput
            ref={inputRef}
            initialValue={formatValue(value)}
            onChangeText={handleChangeText}
            onBlur={handleBlur}
            onSubmitEditing={handleSubmitEditing}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            editable={!disabled}
            size={size}
            inputMode={inputMode}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
            selectTextOnFocus
            accessibilityLabel={label}
            style={INPUT_STYLE}
            testID={testID ? `${testID}-input` : undefined}
          />
        </View>
      </View>
      {shownError ? (
        <Text
          style={styles.error}
          numberOfLines={2}
          testID={testID ? `${testID}-error` : undefined}
        >
          {shownError}
        </Text>
      ) : null}
    </View>
  );
}

function errorText(
  t: ReturnType<typeof useTranslation>["t"],
  draftError: DraftError,
  scale: ScrubScale,
  format: ScrubFormat,
): string | null {
  if (draftError === "invalid") {
    return t("goals.form.numberField.invalid");
  }
  if (draftError === "range") {
    return t("goals.form.numberField.range", {
      min: format.format(scale.min),
      max: format.format(scale.max),
    });
  }
  return null;
}

// Wide enough for "$100000" or "10080m"; the row's label column takes the rest at 390px.
const INPUT_WIDTH = 88;
const HANDLE_WIDTH = 32;
// A plain object: FormTextInput splits its style into chrome and text keys, which Unistyles'
// web class names do not survive. A row chrome lets the input fill the box instead of taking
// its intrinsic web width.
const INPUT_STYLE: TextStyle = { flexDirection: "row", fontVariant: ["tabular-nums"] };

const HANDLE_SIZE_STYLE = {
  xs: "handleXs",
  sm: "handleSm",
  md: "handleMd",
} as const satisfies Record<FieldControlSize, string>;

const styles = StyleSheet.create((theme) => ({
  container: {
    width: HANDLE_WIDTH + theme.spacing[1] + INPUT_WIDTH,
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[1],
  },
  handle: {
    width: HANDLE_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  handleXs: {
    minHeight: CONTROL_HEIGHTS.tight,
  },
  handleSm: {
    minHeight: CONTROL_HEIGHTS.compact,
  },
  handleMd: {
    minHeight: CONTROL_HEIGHTS.field,
    borderRadius: theme.borderRadius.lg,
  },
  handleActive: {
    backgroundColor: theme.colors.surface3,
  },
  disabled: {
    opacity: 0.5,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  iconActive: {
    color: theme.colors.foreground,
  },
  inputBox: {
    width: INPUT_WIDTH,
    borderRadius: theme.borderRadius.lg,
  },
  inputBoxError: {
    // An outline, so the field's own focus and hover border keep working inside it.
    outlineColor: theme.colors.palette.red[300],
    outlineStyle: "solid",
    outlineWidth: 1,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
