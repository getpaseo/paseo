/**
 * One row of a custom context menu.
 *
 * The row owns no state: the highlight, the theme and the callbacks all come
 * from the host, so a level re-renders every row from a single source of truth.
 * The columns are fixed widths (check mark, icon, accelerator, submenu arrow) so
 * every label in a level starts at the same x, which is what makes a menu look
 * like a table rather than a list.
 *
 * @format
 */

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, PointerEvent } from 'react-native';
import { formatAccelerator } from './accelerator';
import type { MenuTheme } from './theme';
import type { MenuEntry } from './types';
import {
  entryAccelerator,
  entryLabel,
  entryTestId,
  isChecked,
  isEnabled,
  isSubmenu,
  submenuItems,
} from './types';

export interface MenuRowProps {
  entry: MenuEntry;
  theme: MenuTheme;
  /** `macos`, `windows` or `linux`, for the accelerator notation. */
  platform: string;
  highlighted: boolean;
  /** Hover entered the row, with the pointer position for the safe triangle. */
  onHover: (point: { x: number; y: number }) => void;
  /**
   * The row was released or activated. Only called for an enabled row. A
   * secondary-button release passes the pointer position, so the host can tell
   * the tail of the click that opened the menu from a deliberate drag onto the
   * row.
   */
  onPress: (point?: { x: number; y: number }) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}

/** The arrow glyph has no accelerator column to share, so it gets its own width. */
const ARROW_WIDTH = 12;
const ICON_SIZE = 16;

export function MenuRow({
  entry,
  theme,
  platform,
  highlighted,
  onHover,
  onPress,
  onLayout,
}: MenuRowProps) {
  const enabled = isEnabled(entry);
  const checked = isChecked(entry);
  const submenu = isSubmenu(entry);
  const accelerator = formatAccelerator(entryAccelerator(entry), platform);
  const label = entryLabel(entry);
  const colour = !enabled
    ? theme.disabledForeground
    : highlighted
      ? theme.highlightForeground
      : theme.foreground;
  const mutedColour = !enabled
    ? theme.disabledForeground
    : highlighted
      ? theme.highlightForeground
      : theme.mutedForeground;

  // A secondary press never reaches RN's responder system, so a `Pressable`'s
  // `onPress` would not fire for the right-button drag that is still held from
  // the click that opened the menu. Reporting the release here is what makes
  // press-drag-release work, and the position lets the host tell a deliberate
  // drag from the tail of the opening click.
  const handlePointerUp = React.useCallback(
    (event: PointerEvent) => {
      if (!enabled || event.nativeEvent.button === 0) {
        return;
      }
      onPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
    },
    [enabled, onPress],
  );

  return (
    <Pressable
      testID={`menu-item-${entryTestId(entry)}`}
      accessibilityRole="menuitem"
      accessibilityState={{
        checked,
        disabled: !enabled,
        selected: highlighted,
      }}
      focusable={false}
      onPointerEnter={event =>
        onHover({
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
        })
      }
      onPointerUp={handlePointerUp}
      onPress={enabled ? () => onPress() : undefined}
      onLayout={onLayout}
      style={[
        styles.row,
        {
          height: theme.rowHeight,
          paddingHorizontal: theme.paddingX,
          backgroundColor: highlighted ? theme.highlightBackground : undefined,
        },
      ]}
    >
      <View style={styles.checkColumn}>
        {checked ? (
          <Text
            style={[styles.glyph, { color: colour, fontSize: theme.fontSize }]}
          >
            {'\u2713'}
          </Text>
        ) : null}
      </View>
      <View style={styles.iconColumn}>
        {entry.icon != null ? (
          <Image
            source={entry.icon}
            style={[styles.icon, { tintColor: colour }]}
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          {
            color: colour,
            fontSize: theme.fontSize,
            fontFamily: theme.fontFamily,
          },
        ]}
      >
        {label}
      </Text>
      {accelerator !== '' ? (
        <Text
          numberOfLines={1}
          style={[
            styles.accelerator,
            {
              color: mutedColour,
              fontSize: theme.fontSize - 1,
              fontFamily: theme.fontFamily,
            },
          ]}
        >
          {accelerator}
        </Text>
      ) : null}
      <View style={styles.arrowColumn}>
        {submenu && submenuItems(entry) != null ? (
          <Text
            style={[
              styles.glyph,
              { color: mutedColour, fontSize: theme.fontSize },
            ]}
          >
            {'\u203a'}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 4,
  },
  checkColumn: {
    width: ICON_SIZE,
    alignItems: 'center',
  },
  iconColumn: {
    width: ICON_SIZE,
    alignItems: 'center',
    marginRight: 6,
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  label: {
    flex: 1,
  },
  accelerator: {
    marginLeft: 16,
    textAlign: 'right',
  },
  arrowColumn: {
    width: ARROW_WIDTH,
    alignItems: 'flex-end',
  },
  glyph: {
    textAlign: 'center',
  },
});
