/**
 * `Tray` — menu-bar (tray) apps.
 *
 * ```ts
 * await Tray.install({ component: 'MenuBarPanel', tooltip: 'My app' });
 * ```
 *
 * The icon's click opens `component` in a popover window; a menu shown instead
 * reports its selection as the `gpuiDesktop:trayMenuPress` device event, which
 * {@link Tray.onMenuPress} subscribes to.
 *
 * Platform notes: Windows has no anchored popover (the window is placed at the
 * click point), and on GNOME a Linux AppIndicator only supports menus, not
 * click-to-popover.
 *
 * @format
 */

import { DeviceEventEmitter } from 'react-native';
import NativeGpuiTray from '../specs/NativeGpuiTray';
import { nativeRequest } from './index';
import { iconUri, nativeMenuItems } from './menu';
import type { DesktopIcon, MenuItemSpec } from './menu';

/** Runs one GpuiTray method with the shared module check. */
function request<T>(
  run: (native: NonNullable<typeof NativeGpuiTray>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiTray', check => run(check(NativeGpuiTray)));
}

export interface TrayOptions {
  /** Stable id; defaults to `tray`. */
  id?: string;
  tooltip?: string;
  /** Text beside the icon. macOS and Linux; Windows trays have no title. */
  title?: string;
  /** The icon. Without one the tray shows a built-in glyph. */
  icon?: DesktopIcon;
  /**
   * macOS: draw the icon as a template, a mask the menu bar tints for light
   * and dark mode. Use it for a monochrome glyph. Defaults to false.
   */
  iconTemplate?: boolean;
  component?: string;
  size?: { width: number; height: number };
  menu?: MenuItemSpec[];
  menuOnLeftClick?: boolean;
  /**
   * Quit when the last window closes. Defaults to false: a tray app keeps
   * running without a window, and on macOS the Dock icon reopens one.
   */
  quitOnLastWindowClosed?: boolean;
  /**
   * What closing the app's last window does while the tray keeps the app running.
   *
   * `false` (the default) closes it: the window and its React tree are gone, and
   * opening the app again from the tray starts from the first screen, centered at
   * the configured size. `true` hides it instead: opening the app again shows the
   * same window where it was, on the screen it was on, with its state intact — at
   * the cost of the hidden window's React tree staying alive in the background.
   *
   * Only the last window is hidden; closing one of several closes it. It has no
   * effect together with `quitOnLastWindowClosed`, which ends the app instead.
   */
  hideWindowOnClose?: boolean;
}

export interface TrayState {
  installed: boolean;
  id?: string;
  tooltip?: string | null;
  visible?: boolean;
  component?: string | null;
  popover?: number | null;
  clicks?: number;
  hasMenu?: boolean;
  menuItems?: unknown[];
  hideWindowOnClose?: boolean;
  title?: string | null;
  /** The custom icon's size and mode; null while the built-in glyph shows. */
  icon?: { width: number; height: number; template: boolean } | null;
}

const MENU_PRESS_EVENT = 'gpuiDesktop:trayMenuPress';

export const Tray = {
  install(options: TrayOptions = {}): Promise<{ id: string }> {
    const { icon, menu, ...rest } = options;
    return request(native =>
      native.trayInstall({
        ...rest,
        icon: iconUri(icon),
        menu: menu ? nativeMenuItems(menu) : undefined,
      }),
    );
  },

  destroy(): Promise<void> {
    return request(native => native.trayDestroy());
  },

  setTooltip(tooltip: string | null): Promise<void> {
    return request(native => native.traySetTooltip(tooltip));
  },

  setVisible(visible: boolean): Promise<void> {
    return request(native => native.traySetVisible(visible));
  },

  /** Replaces the icon; `template` is as in {@link TrayOptions.iconTemplate}. */
  setIcon(
    icon: DesktopIcon,
    { template = false }: { template?: boolean } = {},
  ): Promise<void> {
    const uri = iconUri(icon);
    if (uri == null) {
      return Promise.reject(new Error('Tray.setIcon needs an image source'));
    }
    return request(native => native.traySetIcon(uri, template));
  },

  setTitle(title: string | null): Promise<void> {
    return request(native => native.traySetTitle(title));
  },

  setMenu(items: MenuItemSpec[] | null): Promise<void> {
    return request(native =>
      native.traySetMenu(items ? nativeMenuItems(items) : null),
    );
  },

  getState(): Promise<TrayState> {
    return request(native => native.trayGetState()) as Promise<TrayState>;
  },

  onMenuPress(handler: (id: string) => void): { remove: () => void } {
    const subscription = DeviceEventEmitter.addListener(
      MENU_PRESS_EVENT,
      (event: { id?: string }) => {
        if (event?.id != null) {
          handler(event.id);
        }
      },
    );
    return { remove: () => subscription.remove() };
  },
};
