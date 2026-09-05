import React, { useCallback, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { settingsStyles } from "@/styles/settings";

export interface FontSizeRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  draft: string;
  withBorder?: boolean;
  onChangeDraft: (value: string) => void;
  /** Commits the draft and returns the clamped value the field should now show. */
  onCommit: () => string;
}

/**
 * A numeric px field on a settings row. Commits on blur or submit; the owner
 * clamps and reports back the value that was actually stored.
 */
export function FontSizeRow({
  title,
  hint,
  accessibilityLabel,
  draft,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: FontSizeRowProps) {
  const inputRef = useRef<EditingTextInputHandle>(null);

  // The field is uncontrolled, so re-rendering with a corrected `draft` does not
  // change what is on screen. Push the clamped value through the imperative handle
  // instead. This matters most when an out-of-range entry clamps to the value that
  // was already stored: nothing else re-syncs the field, so the rejected number
  // would sit there looking accepted until the screen was left and reopened.
  const handleCommit = useCallback(() => {
    const committed = onCommit();
    if (committed !== inputRef.current?.getText()) {
      inputRef.current?.replaceText(committed);
    }
  }, [onCommit]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          ref={inputRef}
          initialValue={draft}
          onChangeText={onChangeDraft}
          onBlur={handleCommit}
          onSubmitEditing={handleCommit}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.sizeInput}
          accessibilityLabel={accessibilityLabel}
        />
        <Text style={styles.unit}>px</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Mirrors the divider row in appearance-section.tsx, which still owns the font
  // *family* rows. Kept local so this module carries its own style identity.
  rowWithBorder: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  sizeField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sizeInput: {
    width: 64,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
