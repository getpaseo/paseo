/**
 * `@react-native-menu/menu` polyfill.
 *
 * Existing apps (and Zeego, which builds on this package) can keep importing
 * `@react-native-menu/menu` if their Metro config maps the package name here:
 *
 * ```js
 * // metro.config.js
 * resolver: {
 *   extraNodeModules: {
 *     '@react-native-menu/menu': require.resolve('@react-native-gpui/core/polyfills/menu'),
 *   },
 * }
 * ```
 *
 * Supported: `actions` (`subactions`, `state: 'on' | 'off' | 'mixed'`,
 * `attributes.disabled`, `attributes.hidden`, `attributes.destructive`),
 * `onPressAction`, `shouldOpenOnLongPress` (false opens on a primary press),
 * `title`. Ignored: `themeVariant`, `hitSlop` beyond what `View` takes, and
 * icon-based attributes (see the README).
 *
 * @format
 */

import React from 'react';
import { Pressable, View } from 'react-native';
import type { ViewProps } from 'react-native';
import { ContextMenu } from '../src-gpui/src/private/desktop/contextMenu';
import type { MenuItemSpec } from '../src-gpui/src/private/desktop/menu';

export interface MenuAction {
  id: string;
  title: string;
  attributes?: {
    disabled?: boolean;
    hidden?: boolean;
    destructive?: boolean;
  };
  state?: 'on' | 'off' | 'mixed';
  subactions?: MenuAction[];
  image?: string;
  imageColor?: string;
}

export interface MenuViewProps extends ViewProps {
  actions: MenuAction[];
  onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  shouldOpenOnLongPress?: boolean;
  title?: string;
  children?: React.ReactNode;
}

export function toMenuItems(actions: MenuAction[]): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  for (const action of actions) {
    if (action.attributes?.hidden) {
      continue;
    }
    const enabled = !action.attributes?.disabled;
    if (action.subactions != null && action.subactions.length > 0) {
      items.push({
        type: 'submenu',
        id: action.id,
        label: action.title,
        enabled,
        items: toMenuItems(action.subactions),
      });
      continue;
    }
    items.push({
      id: action.id,
      label: action.title,
      enabled,
      checked: action.state === 'on',
    });
  }
  return items;
}

export function MenuView({
  actions,
  onPressAction,
  shouldOpenOnLongPress = true,
  // `title` is part of the upstream API but the desktop model has no menu
  // title; it is ignored rather than rejected.
  title: _title,
  children,
  ...viewProps
}: MenuViewProps) {
  const open = React.useCallback(
    (x: number, y: number, windowId?: number) => {
      ContextMenu.show(toMenuItems(actions), { x, y, windowId })
        .then(id => {
          if (id != null) {
            onPressAction?.({ nativeEvent: { event: id } });
          }
        })
        .catch(() => {});
    },
    [actions, onPressAction],
  );

  if (shouldOpenOnLongPress) {
    return (
      <View
        {...viewProps}
        onContextMenu={event =>
          open(
            event.nativeEvent.x,
            event.nativeEvent.y,
            event.nativeEvent.windowId,
          )
        }
      >
        {children}
      </View>
    );
  }

  return (
    <Pressable
      {...viewProps}
      onPress={event =>
        open(event.nativeEvent.pageX ?? 0, event.nativeEvent.pageY ?? 0)
      }
    >
      {children}
    </Pressable>
  );
}

export default { MenuView };
