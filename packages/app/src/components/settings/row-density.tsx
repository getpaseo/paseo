import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CONTROL_HEIGHTS, mapLayout, type ControlSize } from "@/components/ui/control-geometry";
import { menuRowContentInset } from "@/components/ui/menu";

import { settingsStyles } from "@/styles/settings";

// The container decides how its rows lay out; a row never knows on its own where it is.
//
// - card: the rows of a settings card.
// - nested: rows revealed under a collapsible row belong to it, so they sit one step smaller than
//   the rows of the card: tighter padding, smaller text, smaller controls.
// - menu: rows that share a menu surface with menu rows put their labels on the menu's label rail.
type RowPlacement = "card" | "nested" | "menu";

const RowPlacementContext = createContext<RowPlacement>("card");

export function NestedSettingsRows({ children }: { children: ReactNode }) {
  return <RowPlacementContext.Provider value="nested">{children}</RowPlacementContext.Provider>;
}

/** Settings rows rendered in a menu surface, alongside menu rows. */
export function MenuSettingsRows({ children }: { children: ReactNode }) {
  return <RowPlacementContext.Provider value="menu">{children}</RowPlacementContext.Provider>;
}

export interface SettingsRowLayout {
  row: StyleProp<ViewStyle>;
  /**
   * A row as tall as one holding a control of `controlSize`, whether or not it holds one. In a menu
   * it keeps the menu's row height.
   */
  controlRow: StyleProp<ViewStyle>;
  title: StyleProp<TextStyle>;
  hint: StyleProp<TextStyle>;
  /** The size of the controls in the row's trailing slot. */
  controlSize: ControlSize;
}

function layoutFor(placement: RowPlacement): SettingsRowLayout {
  switch (placement) {
    case "nested":
      return {
        row: [settingsStyles.row, styles.nestedRow],
        controlRow: [settingsStyles.row, styles.nestedRow],
        title: [settingsStyles.rowTitle, styles.nestedText],
        hint: [settingsStyles.rowHint, styles.nestedText],
        controlSize: "sm",
      };
    case "menu":
      return {
        row: [settingsStyles.row, styles.menuRow],
        controlRow: [settingsStyles.row, styles.menuRow],
        title: settingsStyles.rowTitle,
        hint: settingsStyles.rowHint,
        controlSize: "md",
      };
    case "card":
      return {
        row: settingsStyles.row,
        controlRow: [settingsStyles.row, styles.cardControlRow],
        title: settingsStyles.rowTitle,
        hint: settingsStyles.rowHint,
        controlSize: "md",
      };
  }
}

/** How a row lays out where it is rendered: in a card, nested under a collapsible row, or in a menu. */
export function useSettingsRowLayout(): SettingsRowLayout {
  const placement = useContext(RowPlacementContext);
  return useMemo(() => layoutFor(placement), [placement]);
}

const styles = StyleSheet.create((theme) => ({
  cardControlRow: {
    minHeight: mapLayout(CONTROL_HEIGHTS.md, (height) => height + theme.spacing[4] * 2),
  },
  // Every nested row is as tall as one holding an `sm` control, so rows with and without a
  // trailing button line up.
  nestedRow: {
    paddingVertical: theme.spacing[2],
    minHeight: mapLayout(CONTROL_HEIGHTS.sm, (height) => height + theme.spacing[2] * 2),
  },
  nestedText: {
    fontSize: theme.fontSize.sm,
  },
  menuRow: {
    paddingHorizontal: menuRowContentInset(theme),
  },
}));
