/**
 * One level of a custom context menu: a panel with rows and separators.
 *
 * The surface draws and reports; it does not place itself. The host measures it,
 * runs `placement.ts` and hands back the resulting position, because only the
 * host knows the window size and the open submenu chain. Keeping that split also
 * means a replacement `Surface` renderer can be a plain drawing component.
 *
 * @format
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import type {
  KeyDownEvent,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { MenuRow } from './MenuRow';
import type { MenuRowProps } from './MenuRow';
import type { MenuTheme } from './theme';
import type { MenuEntry } from './types';
import { entryTestId, isSeparator } from './types';

/** What a replaced separator is given: the theme and the row it sits after. */
export interface MenuSeparatorProps {
  theme: MenuTheme;
  index: number;
}

export interface MenuSurfaceProps {
  items: MenuEntry[];
  /** The highlighted row of this level, or `-1` for none. */
  highlightedIndex: number;
  theme: MenuTheme;
  platform: string;
  /** The host's placement, in window coordinates. */
  style?: StyleProp<ViewStyle>;
  /**
   * Takes focus for the level so the panel's `onKeyDown` sees keys. Only the
   * deepest open level is focusable, so a keystroke cannot be handled twice.
   */
  focusable?: boolean;
  panelRef?: React.Ref<React.ElementRef<typeof View>>;
  onKeyDown?: (event: KeyDownEvent) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Reports the row's index and its measured height, for hit testing. */
  onRowLayout?: (index: number, event: LayoutChangeEvent) => void;
  onRowHover?: (index: number, point: { x: number; y: number }) => void;
  onRowPress?: (index: number, point?: { x: number; y: number }) => void;
  /** Replaces the built-in row. The host still owns hover, press and keys. */
  renderRow?: React.ComponentType<MenuRowProps>;
  /** Replaces the built-in separator. */
  renderSeparator?: React.ComponentType<MenuSeparatorProps>;
}

export function MenuSurface({
  items,
  highlightedIndex,
  theme,
  platform,
  style,
  focusable = false,
  panelRef,
  onKeyDown,
  onLayout,
  onRowLayout,
  onRowHover,
  onRowPress,
  renderRow: Row = MenuRow,
  renderSeparator: Separator,
}: MenuSurfaceProps) {
  return (
    <View
      ref={panelRef}
      accessibilityRole="menu"
      focusable={focusable}
      onKeyDown={onKeyDown}
      onLayout={onLayout}
      style={[
        styles.panel,
        {
          backgroundColor: theme.background,
          borderColor: theme.border,
          borderRadius: theme.radius,
          // A width range rather than a fixed size: a menu is as wide as its
          // longest row, and a fixed width would either clip a long label or
          // waste space on a short one.
          minWidth: theme.minWidth,
          maxWidth: theme.maxWidth,
          paddingVertical: theme.paddingY,
          // The GPUI renderer turns these props into a box shadow, so the panel
          // gets its depth from the theme like any other view.
          shadowColor: theme.shadow,
        },
        style,
      ]}
    >
      {items.map((entry, index) => {
        if (isSeparator(entry)) {
          if (Separator != null) {
            return (
              <Separator
                key={`separator-${index}`}
                theme={theme}
                index={index}
              />
            );
          }
          return (
            <View
              key={`separator-${index}`}
              style={[
                styles.separator,
                {
                  backgroundColor: theme.separator,
                  marginVertical: theme.paddingY,
                  marginHorizontal: theme.paddingX / 2,
                },
              ]}
            />
          );
        }
        return (
          <Row
            key={`${entryTestId(entry)}-${index}`}
            entry={entry}
            theme={theme}
            platform={platform}
            highlighted={index === highlightedIndex}
            onHover={point => onRowHover?.(index, point)}
            onPress={point => onRowPress?.(index, point)}
            onLayout={
              onRowLayout == null
                ? undefined
                : event => onRowLayout(index, event)
            }
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    // No `overflow: hidden`: the rows are inset by the panel's padding, so
    // nothing needs clipping, and clipping would cut the shadow off.
    paddingHorizontal: 4,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    shadowOpacity: 1,
    elevation: 8,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
