import { createElement, useCallback, type ChangeEvent, type CSSProperties } from "react";
import { Text } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { BrowserElementField, BrowserElementJson } from "@/desktop/browser/element-context";
import { toColorPickerValue } from "@/desktop/browser/element-context-field-value";
import {
  elementContextFieldStyles as styles,
  nativeColorInputStyle,
  nativeDateInputStyle,
  nativeRangeInputStyle,
} from "@/desktop/browser/element-context-fields.styles.electron";

function ElementContextNativeField({
  field,
  value,
  disabled,
  onChange,
  inputTheme,
}: {
  field: BrowserElementField;
  value: string;
  disabled: boolean;
  onChange: (value: BrowserElementJson) => void;
  inputTheme: CSSProperties;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.value;
      const isNumeric = field.editor === "slider" || field.editor === "number";
      onChange(isNumeric && next !== "" ? Number(next) : next);
    },
    [field.editor, onChange],
  );

  if (field.editor === "color") {
    return createElement("input", {
      "aria-label": `${field.label} picker`,
      disabled,
      onChange: handleChange,
      style: nativeColorInputStyle,
      type: "color",
      value: toColorPickerValue(value),
    });
  }

  if (field.editor === "slider") {
    return (
      <>
        {createElement("input", {
          "aria-label": field.label,
          disabled,
          max: field.max,
          min: field.min,
          onChange: handleChange,
          step: field.step,
          style: nativeRangeInputStyle,
          type: "range",
          value,
        })}
        <Text style={styles.nativeValue}>{value || "0"}</Text>
      </>
    );
  }

  if (field.editor === "number") {
    return createElement("input", {
      "aria-label": field.label,
      disabled,
      max: field.max,
      min: field.min,
      onChange: handleChange,
      step: field.step,
      style: { ...nativeDateInputStyle, ...inputTheme },
      type: "number",
      value,
    });
  }

  const type = field.editor === "datetime" ? "datetime-local" : field.editor;
  return createElement("input", {
    "aria-label": field.label,
    disabled,
    onChange: handleChange,
    style: { ...nativeDateInputStyle, ...inputTheme },
    type,
    value,
  });
}

export const NativeElementContextField = withUnistyles(ElementContextNativeField, (theme) => ({
  inputTheme: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    colorScheme: theme.colorScheme,
  },
}));
