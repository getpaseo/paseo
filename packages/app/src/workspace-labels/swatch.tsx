import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelColor,
} from "@getpaseo/protocol/workspace-labels";
import { identityForeground } from "@/styles/identity-colors";
import { i18n } from "@/i18n/i18next";
import type { Theme } from "@/styles/theme";

/**
 * A label's color as ink: the dot in front of its name, the swatches you pick it from, and the
 * tint mapping the sidebar's label group headers hand to a glyph.
 *
 * The ten names are the identity table's ten (`@/styles/identity-colors`) — the protocol happens
 * to spell them out again as `WorkspaceLabelColor`, and every `identityForeground` call below is
 * the compile-time proof that the two lists still agree. Nothing here picks a hex: a label sits
 * on the same sidebar row as a host badge and a CI check, and the identity table is the one place
 * that holds all three to a single contrast band.
 */

/** Matches the status dot next to it in a menu row: small enough to mark, not to rank. */
const DOT_SIZE = 10;

/** Big enough to judge a color by, and the swatch grid's only unit — see `hitSlop` below. */
const SWATCH_SIZE = 20;

export function workspaceLabelColorName(color: WorkspaceLabelColor): string {
  return i18n.t(`workspaceLabels.colors.${color}`);
}

/**
 * One stable mapping per color for the life of the module, for lucide glyphs that carry a
 * label's color (`withUnistyles` re-subscribes when `uniProps` changes identity). The scheme is
 * read inside the mapping, so switching themes repaints the glyph without a React render.
 */
export const WORKSPACE_LABEL_ICON_MAPPINGS: Record<
  WorkspaceLabelColor,
  (theme: Theme) => { color: string }
> = Object.fromEntries(
  WORKSPACE_LABEL_COLORS.map((color) => [
    color,
    (theme: Theme) => ({ color: identityForeground(color, theme.colorScheme) }),
  ]),
) as Record<WorkspaceLabelColor, (theme: Theme) => { color: string }>;

/** The mark that stands in for a label wherever its name is already spelled out beside it. */
export function WorkspaceLabelDot({ color }: { color: WorkspaceLabelColor }): ReactElement {
  return <View style={[styles.dot, fillStyle(color)]} />;
}

/**
 * The ten colors a label can take, as one row of swatches.
 *
 * The swatch is the whole visual — the 44pt target comes from `hitSlop` growing outward, so the
 * row's rhythm is set by the swatches themselves rather than by ten touch targets with color
 * somewhere inside them. Selection is an inset ring, which React Native draws inside the box, so
 * picking a color cannot reflow the row.
 */
export function WorkspaceLabelSwatchRow({
  value,
  onChange,
  disabled = false,
  testID,
}: {
  value: WorkspaceLabelColor | null;
  onChange: (color: WorkspaceLabelColor) => void;
  disabled?: boolean;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.swatchRow} testID={testID}>
      {WORKSPACE_LABEL_COLORS.map((color) => (
        <WorkspaceLabelSwatch
          key={color}
          color={color}
          selected={color === value}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </View>
  );
}

function WorkspaceLabelSwatch({
  color,
  selected,
  disabled,
  onChange,
}: {
  color: WorkspaceLabelColor;
  selected: boolean;
  disabled: boolean;
  onChange: (color: WorkspaceLabelColor) => void;
}): ReactElement {
  const select = useCallback(() => onChange(color), [color, onChange]);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={workspaceLabelColorName(color)}
      accessibilityState={accessibilityState}
      aria-checked={selected}
      disabled={disabled}
      hitSlop={SWATCH_HIT_SLOP}
      onPress={select}
      style={[styles.swatch, fillStyle(color), selected && styles.swatchSelected]}
      testID={`workspace-label-swatch-${color}`}
    />
  );
}

// Grows the 20pt swatch to a 44pt target without moving it. Padding here would push its
// neighbours apart and leave the row's spacing to the touch targets rather than the color.
const SWATCH_HIT_SLOP = (44 - SWATCH_SIZE) / 2;

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  swatch: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  swatchSelected: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.foreground,
  },
  // The one place a label color becomes a fill. Scheme-dependent, so it has to be a registered
  // style rather than a computed value: `identityForeground` needs the active scheme, and a
  // module-scope read would freeze on whichever theme happened to be up first.
  fillViolet: { backgroundColor: identityForeground("violet", theme.colorScheme) },
  fillSky: { backgroundColor: identityForeground("sky", theme.colorScheme) },
  fillEmerald: { backgroundColor: identityForeground("emerald", theme.colorScheme) },
  fillOrange: { backgroundColor: identityForeground("orange", theme.colorScheme) },
  fillPink: { backgroundColor: identityForeground("pink", theme.colorScheme) },
  fillIndigo: { backgroundColor: identityForeground("indigo", theme.colorScheme) },
  fillTeal: { backgroundColor: identityForeground("teal", theme.colorScheme) },
  fillRed: { backgroundColor: identityForeground("red", theme.colorScheme) },
  fillAmber: { backgroundColor: identityForeground("amber", theme.colorScheme) },
  fillBlue: { backgroundColor: identityForeground("blue", theme.colorScheme) },
}));

// Read inside render, never into a module-scope table — see docs/unistyles.md.
function fillStyle(color: WorkspaceLabelColor) {
  switch (color) {
    case "violet":
      return styles.fillViolet;
    case "sky":
      return styles.fillSky;
    case "emerald":
      return styles.fillEmerald;
    case "orange":
      return styles.fillOrange;
    case "pink":
      return styles.fillPink;
    case "indigo":
      return styles.fillIndigo;
    case "teal":
      return styles.fillTeal;
    case "red":
      return styles.fillRed;
    case "amber":
      return styles.fillAmber;
    case "blue":
      return styles.fillBlue;
  }
}
