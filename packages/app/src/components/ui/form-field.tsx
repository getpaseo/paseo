import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type PressableStateCallbackType,
  type TextInput,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
  type FieldControlSize,
} from "@/components/ui/control-geometry";

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
  testID?: string;
}

export function Field({ label, children, hint, error, testID }: FieldProps) {
  const hintTestID = useMemo(() => (testID ? `${testID}-hint` : undefined), [testID]);
  const errorTestID = useMemo(() => (testID ? `${testID}-error` : undefined), [testID]);
  const subtext = useMemo(() => {
    if (error) {
      return (
        <Text numberOfLines={1} style={styles.errorText} testID={errorTestID}>
          {error}
        </Text>
      );
    }
    if (hint) {
      return (
        <Text numberOfLines={1} style={styles.hintText} testID={hintTestID}>
          {hint}
        </Text>
      );
    }
    return null;
  }, [error, hint, errorTestID, hintTestID]);

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {subtext}
    </View>
  );
}

type FormTextInputProps = AdaptiveTextInputProps & {
  size?: FieldControlSize;
};

type FlatFormTextInputStyle = ViewStyle & TextStyle;

interface SplitFormTextInputStyle {
  chromeStyle?: ViewStyle;
  inputStyle?: TextStyle;
}

function splitFormTextInputStyle(style: AdaptiveTextInputProps["style"]): SplitFormTextInputStyle {
  const flattened = RNStyleSheet.flatten(style) as FlatFormTextInputStyle | undefined;
  if (!flattened) {
    return {};
  }

  const {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
    ...chromeStyle
  } = flattened;

  const inputStyle: TextStyle = {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
  };

  return {
    chromeStyle: stripUnistylesMetadata(chromeStyle),
    inputStyle: stripUnistylesMetadata(inputStyle),
  };
}

function stripUnistylesMetadata<TStyle extends object>(style: TStyle): TStyle {
  const cleanStyle: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    if (key.startsWith("unistyles_") || value === undefined) {
      continue;
    }
    cleanStyle[key] = value;
  }
  return cleanStyle as TStyle;
}

function assignTextInputRef(forwardedRef: ForwardedRef<TextInput>, node: TextInput | null): void {
  if (typeof forwardedRef === "function") {
    forwardedRef(node);
    return;
  }
  if (forwardedRef) {
    forwardedRef.current = node;
  }
}

export const FormTextInput = forwardRef<TextInput, FormTextInputProps>(function FormTextInput(
  { size = "md", style, onFocus, onBlur, editable, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const isDisabled = editable === false;
  const chromeSizeStyle = size === "sm" ? formInputStyles.chromeSm : formInputStyles.chromeMd;
  const inputSizeStyle = size === "sm" ? formInputStyles.inputSm : formInputStyles.inputMd;
  const splitStyle = useMemo(() => splitFormTextInputStyle(style), [style]);
  const setInputRef = useCallback(
    (node: TextInput | null) => {
      assignTextInputRef(ref, node);
    },
    [ref],
  );
  const handleFocus = useCallback<NonNullable<AdaptiveTextInputProps["onFocus"]>>(
    (event) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );
  const handleBlur = useCallback<NonNullable<AdaptiveTextInputProps["onBlur"]>>(
    (event) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );
  const inputStyle = useMemo(
    () => [formInputStyles.input, inputSizeStyle, splitStyle.inputStyle],
    [inputSizeStyle, splitStyle.inputStyle],
  ) as AdaptiveTextInputProps["style"];
  const chromeStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      formInputStyles.chrome,
      chromeSizeStyle,
      resolveControlInteractionStyles(
        {
          controlRest: formInputStyles.controlRest,
          controlHover: formInputStyles.controlHover,
          controlActive: formInputStyles.controlActive,
          controlDisabled: formInputStyles.controlDisabled,
        },
        {
          hovered,
          focused,
          disabled: isDisabled,
        },
      ),
      splitStyle.chromeStyle,
    ],
    [chromeSizeStyle, focused, isDisabled, splitStyle.chromeStyle],
  );

  return (
    <Pressable disabled={isDisabled} style={chromeStyle}>
      <AdaptiveTextInput
        ref={setInputRef}
        editable={editable}
        {...props}
        onBlur={handleBlur}
        onFocus={handleFocus}
        style={inputStyle}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.4),
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.4),
  },
}));

const formInputStyles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    chrome: {
      backgroundColor: theme.colors.surface2,
    },
    chromeSm: {
      ...geometry.fieldControlSm,
    },
    chromeMd: {
      ...geometry.fieldControlMd,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    input: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      paddingHorizontal: 0,
      paddingVertical: 0,
      outlineColor: "transparent",
      outlineWidth: 0,
    },
    inputSm: {
      ...geometry.fieldTextSm,
    },
    inputMd: {
      ...geometry.fieldTextMd,
    },
  };
});
