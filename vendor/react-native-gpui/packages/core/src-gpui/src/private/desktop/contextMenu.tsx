/**
 * `ContextMenu` — native context menus.
 *
 * @format
 */

import React from 'react';
import { View } from 'react-native';
import type { ViewProps } from 'react-native';
import NativeGpuiContextMenu from '../specs/NativeGpuiContextMenu';
import NativeContextMenuView from '../specs/DesktopContextMenuViewNativeComponent';
import { DesktopError, platform, toDesktopError } from './index';
import type {
  DesktopContextMenuEvent,
  DesktopContextMenuEventData,
} from '../../../../types';

function contextMenuModule() {
  if (NativeGpuiContextMenu == null) {
    throw new DesktopError(
      'unsupported',
      'the GpuiContextMenu native module is not available',
    );
  }
  return NativeGpuiContextMenu;
}

async function request<T>(
  run: (native: typeof NativeGpuiContextMenu) => Promise<T>,
): Promise<T> {
  try {
    return await run(contextMenuModule());
  } catch (error) {
    throw toDesktopError(error);
  }
}
import { nativeMenuItems, type MenuItemSpec } from './menu';
import { contextMenuHostFor } from './contextMenu/registry';
import type { MenuRenderers } from './contextMenu/config';
import {
  contextMenuPresentation,
  setContextMenuPresentation,
  setContextMenuRenderers,
  setContextMenuTheme,
} from './contextMenu/config';
import type { MenuThemeSet } from './contextMenu/theme';
import { MAIN_WINDOW_ID } from './windowContext';

export interface ContextMenuOptions {
  x?: number;
  y?: number;
  windowId?: number;
  /** Overrides the app default for this call only. */
  presentation?: ContextMenuPresentation;
}

/**
 * Which presenter a call uses.
 *
 * `'default'` means the app's choice, and an app that never set one gets the
 * platform's own menu. Resolving it here rather than at each call site keeps
 * `setPresentation` working for code that already passes `'default'`.
 */
function resolvePresentation(
  presentation?: ContextMenuPresentation,
): 'custom' | 'native' {
  const chosen = presentation ?? 'default';
  const appDefault = contextMenuPresentation();
  const resolved = chosen === 'default' ? appDefault : chosen;
  return resolved === 'custom' ? 'custom' : 'native';
}

export const ContextMenu = {
  /**
   * Show a menu and resolve with the chosen item id, or `null` when dismissed.
   *
   * A custom menu is drawn in JS by the context menu host the shell mounts in
   * every window, so it needs a window to draw in and a host to have registered
   * there. A native menu goes straight to the platform, which is why it works
   * while JS is busy.
   */
  async show(
    items: MenuItemSpec[],
    options: ContextMenuOptions = {},
  ): Promise<string | null> {
    const windowId = options.windowId ?? MAIN_WINDOW_ID;
    if (resolvePresentation(options.presentation) === 'custom') {
      const host = contextMenuHostFor(windowId);
      if (host == null) {
        // No host means no window rendered the shell's wrapper: falling back to
        // the native menu is better than silently doing nothing.
        const result = await request(native =>
          native.contextMenuShow(nativeMenuItems(items), options),
        );
        return result.id ?? null;
      }
      const position =
        options.x !== undefined && options.y !== undefined
          ? { x: options.x, y: options.y }
          : undefined;
      return host.open({ items, position, presentation: 'custom' });
    }
    const result = await request(native =>
      native.contextMenuShow(nativeMenuItems(items), options),
    );
    return result.id ?? null;
  },

  /**
   * The presenter `presentation: 'default'` means from now on.
   *
   * `'custom'` is the React menu from section 5, identical on every platform;
   * `'native'` is each platform's own menu.
   */
  setPresentation(presentation: ContextMenuPresentation): void {
    setContextMenuPresentation(presentation);
  },

  /** Overrides the built-in `light` and `dark` theme tokens. */
  setTheme(theme: MenuThemeSet): void {
    setContextMenuTheme(theme);
  },

  /**
   * Replaces the menu's building blocks.
   *
   * The host keeps placement, keyboard handling and dismissal; a replacement
   * only draws. Pass `undefined` for a slot to go back to the built-in.
   */
  setRenderers(renderers: MenuRenderers | undefined): void {
    setContextMenuRenderers(renderers);
  },
};

/** Which renderer opens the menu. */
export type ContextMenuPresentation = 'default' | 'native' | 'custom';

/** The menu opened, and how. */
export interface ContextMenuOpenEvent {
  /** The trigger, in window coordinates. */
  x: number;
  y: number;
  trigger: 'mouse' | 'keyboard';
}

export interface ContextMenuViewProps extends ViewProps {
  items: MenuItemSpec[];
  /**
   * The chosen item. `onPress` is the name this had before the component
   * reported an id the way `ContextMenu.show` does; both run if both are given.
   */
  onSelect?: (id: string) => void;
  onPress?: (id: string) => void;
  /**
   * The menu opened. Runs after it is up, for analytics or state; like the
   * native `onContextMenu` behaviour it cannot cancel the menu, because the
   * menu did not go through JS.
   */
  onOpen?: (event: ContextMenuOpenEvent) => void;
  /** The menu closed with nothing chosen. */
  onDismiss?: () => void;
  /**
   * `default` opens the platform's menu. `custom` is left to JS: this component
   * then behaves like a `View` with `onContextMenu`, so section 5's React menu
   * can open on the press.
   */
  presentation?: ContextMenuPresentation;
  disabled?: boolean;
  children?: React.ReactNode;
}

/**
 * Whether this is the desktop shell, in which case the native component is
 * registered and can be used.
 *
 * Asked of the desktop module rather than inferred from `Platform.OS`, which
 * names an operating system even where no shell is installed. `platform()` is
 * the module's own answer (`null` without the shell), which is the thing
 * actually being asked about.
 *
 * Read once at module scope because it cannot change while the bundle runs: the
 * module is either installed or it is not.
 */
const isDesktop = platform() != null;

/**
 * Declarative wrapper: a secondary click on the view opens `items` and reports
 * the chosen id.
 *
 * With the native presenter the menu opens from native, so it works while JS is
 * busy: JS only hears about the item that was chosen. With `custom` the menu is
 * the React component from `contextMenu/`, drawn in this window, and the press
 * reaches JS first because JS is what renders it.
 */
export function ContextMenuView({
  items,
  onSelect,
  onPress,
  onOpen,
  onDismiss,
  presentation = 'default',
  disabled = false,
  onContextMenu,
  children,
  ...viewProps
}: ContextMenuViewProps) {
  const resolved = resolvePresentation(presentation);
  const nativeItems = React.useMemo(() => nativeMenuItems(items), [items]);

  const report = React.useCallback(
    (id: string) => {
      onPress?.(id);
      onSelect?.(id);
    },
    [onPress, onSelect],
  );

  const handleContextMenu = React.useCallback(
    (event: DesktopContextMenuEvent) => {
      onContextMenu?.(event);
      const { x, y, windowId } = event.nativeEvent;
      // The presentation is passed through rather than re-resolved: `show` owns
      // the choice between the host's React menu and the platform's own, so this
      // cannot disagree with `ContextMenu.setPresentation`.
      ContextMenu.show(items, {
        x,
        y,
        windowId,
        presentation: resolved,
      })
        .then(id => {
          if (id != null) {
            report(id);
          }
        })
        .catch(() => {});
    },
    [items, onContextMenu, report, resolved],
  );

  // A custom menu is React drawn inside the window, so it needs the press to
  // reach JS. Every platform without the shell needs the same thing: there is no
  // host view to ask.
  if (!isDesktop || resolved === 'custom') {
    return (
      <View {...viewProps} onContextMenu={handleContextMenu}>
        {children}
      </View>
    );
  }

  return (
    <NativeContextMenuView
      {...viewProps}
      items={nativeItems}
      presentation={resolved}
      disabled={disabled}
      onMenuSelect={event => report(event.nativeEvent.id)}
      onMenuOpen={event => {
        // The same data a `topContextMenu` carries, so both props can be served
        // from one event. The menu is already up at this point.
        const opened: DesktopContextMenuEventData = {
          ...event.nativeEvent,
          trigger:
            event.nativeEvent.trigger === 'keyboard' ? 'keyboard' : 'mouse',
        };
        onOpen?.({
          x: opened.x,
          y: opened.y,
          trigger: opened.trigger,
        });
        // `onContextMenu` still runs, as it does on the `View` path: the menu
        // opened without JS, so this is the first it hears of the press. It runs
        // after the menu is up and cannot cancel it.
        onContextMenu?.({ ...event, nativeEvent: opened });
      }}
      onMenuDismiss={() => onDismiss?.()}
    >
      {children}
    </NativeContextMenuView>
  );
}
