import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import type { ContainedControlSize } from "@/components/ui/control-size";
import { settingsStyles } from "@/styles/settings";

// Rows revealed under a collapsible row belong to it, so they sit one step smaller than the rows
// of the card: tighter padding, smaller text, smaller controls. The container decides; a row
// never knows on its own that it is nested.
const NestedRowsContext = createContext(false);

export function NestedSettingsRows({ children }: { children: ReactNode }) {
  return <NestedRowsContext.Provider value>{children}</NestedRowsContext.Provider>;
}

export interface SettingsRowLayout {
  row: StyleProp<ViewStyle>;
  title: StyleProp<TextStyle>;
  hint: StyleProp<TextStyle>;
  /** The size of the controls in the row's trailing slot. */
  controlSize: ContainedControlSize;
}

/** How a row lays out where it is rendered: in a card, or nested under a collapsible row. */
export function useSettingsRowLayout(): SettingsRowLayout {
  const nested = useContext(NestedRowsContext);
  return useMemo(
    () =>
      nested
        ? {
            row: [settingsStyles.row, styles.nestedRow],
            title: [settingsStyles.rowTitle, styles.nestedText],
            hint: [settingsStyles.rowHint, styles.nestedText],
            controlSize: "xs",
          }
        : {
            row: settingsStyles.row,
            title: settingsStyles.rowTitle,
            hint: settingsStyles.rowHint,
            controlSize: "sm",
          },
    [nested],
  );
}

const styles = StyleSheet.create((theme) => ({
  // Every nested row is as tall as one holding an `xs` control, so rows with and without a
  // trailing button line up.
  nestedRow: {
    paddingVertical: theme.spacing[2],
    minHeight: CONTROL_HEIGHTS.tight + theme.spacing[2] * 2,
  },
  nestedText: {
    fontSize: theme.fontSize.sm,
  },
}));
