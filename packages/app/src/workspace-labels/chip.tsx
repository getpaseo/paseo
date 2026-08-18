import type { ReactElement } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { identityForeground, identityTint } from "@/styles/identity-colors";
import { SPACING } from "@/styles/theme";

/**
 * How far the ground extends past the name on each side.
 *
 * Exported because it is the chip's optical offset as much as its padding: a caller that puts a
 * chip at the head of a line has to hang the ground by this much to land the name on the rail.
 * A static number from the spacing scale, not a theme read — see docs/unistyles.md.
 */
export const WORKSPACE_LABEL_CHIP_INSET = SPACING[1.5];

/**
 * A label where it is read rather than managed: its name in its own color, on a 10% ground of
 * the same hue — the tint formula the status pills already use.
 *
 * It is the one tinted thing on the workspace meta row, and that is the point. Every other item
 * on that line reports state, so they share the state colors; a label is something a person
 * attached to a workspace, and the ground is what separates that from a passing check sitting
 * next to it. The color comes from the identity table, held to the same contrast band as the
 * host badge beside it, so a chip identifies without shouting.
 *
 * The chip is exactly as tall as the line it sits on: text at the row's `lineHeight`, no vertical
 * padding. A ground that grew the line would push every other row in the sidebar down for it.
 */
export function WorkspaceLabelChip({ label }: { label: WorkspaceLabelDefinition }): ReactElement {
  return (
    <View
      style={[styles.chip, CHIP_GROUNDS[label.color]]}
      testID={`workspace-label-chip-${label.name}`}
    >
      <Text style={[styles.name, nameColorStyle(label.color)]} numberOfLines={1}>
        {label.name}
      </Text>
    </View>
  );
}

// `identityTint` is theme-independent — one hex per name at 10% alpha — so unlike the text color
// these can be built once at module load. There is no Unistyles proxy here to freeze against
// whichever theme happened to be active first.
const CHIP_GROUNDS: Record<WorkspaceLabelColor, ViewStyle> = Object.fromEntries(
  WORKSPACE_LABEL_COLORS.map((color) => [color, { backgroundColor: identityTint(color) }]),
) as Record<WorkspaceLabelColor, ViewStyle>;

const styles = StyleSheet.create((theme) => ({
  chip: {
    // Yields space the way the host badge does, so a long label truncates instead of pushing
    // the change request and its checks off the line.
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: WORKSPACE_LABEL_CHIP_INSET,
    borderRadius: theme.borderRadius.full,
  },
  // No optical nudge: the ground is the text's own line box, so the chip's ink sits on the same
  // baseline as the bare text beside it and centring is whatever the line already does.
  name: {
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 1,
    minWidth: 0,
  },
  // Text has no `color` prop to hand a mapping to, so the name's color has to come from a
  // registered style — one per color, picked at render time. See docs/unistyles.md.
  nameViolet: { color: identityForeground("violet", theme.colorScheme) },
  nameSky: { color: identityForeground("sky", theme.colorScheme) },
  nameEmerald: { color: identityForeground("emerald", theme.colorScheme) },
  nameOrange: { color: identityForeground("orange", theme.colorScheme) },
  namePink: { color: identityForeground("pink", theme.colorScheme) },
  nameIndigo: { color: identityForeground("indigo", theme.colorScheme) },
  nameTeal: { color: identityForeground("teal", theme.colorScheme) },
  nameRed: { color: identityForeground("red", theme.colorScheme) },
  nameAmber: { color: identityForeground("amber", theme.colorScheme) },
  nameBlue: { color: identityForeground("blue", theme.colorScheme) },
}));

function nameColorStyle(color: WorkspaceLabelColor) {
  switch (color) {
    case "violet":
      return styles.nameViolet;
    case "sky":
      return styles.nameSky;
    case "emerald":
      return styles.nameEmerald;
    case "orange":
      return styles.nameOrange;
    case "pink":
      return styles.namePink;
    case "indigo":
      return styles.nameIndigo;
    case "teal":
      return styles.nameTeal;
    case "red":
      return styles.nameRed;
    case "amber":
      return styles.nameAmber;
    case "blue":
      return styles.nameBlue;
  }
}
