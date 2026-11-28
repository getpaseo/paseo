/**
 * `Menu` — the application menu bar.
 *
 * @format
 */

import React from 'react';
import { DeviceEventEmitter, Image } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import NativeGpuiAppMenu from '../specs/NativeGpuiAppMenu';
import { nativeRequest } from './index';
import type { Subscription } from './windows';

/** Runs one GpuiAppMenu method with the shared module check. */
function request<T>(
  run: (native: NonNullable<typeof NativeGpuiAppMenu>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiAppMenu', check => run(check(NativeGpuiAppMenu)));
}

/** The roles a custom menu can ask the host to perform. */
export type MenuRoleAction =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteWithoutFormatting'
  | 'selectAll'
  | 'minimize'
  | 'zoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'toggleFullscreen'
  | 'close'
  | 'quit'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'about';

export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteWithoutFormatting'
  | 'selectAll'
  | 'minimize'
  | 'zoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'toggleFullscreen'
  | 'close'
  | 'help'
  | 'appMenu'
  | 'editMenu'
  | 'windowMenu'
  | 'helpMenu';

/**
 * An image a menu item or the tray shows: anything `<Image source>` takes
 * (`require('./icon.png')`, `{ uri }`), or a path or URI as a string.
 */
export type DesktopIcon = ImageSourcePropType | string;

export type MenuItemSpec =
  | {
      type?: 'item';
      id: string;
      label: string;
      accelerator?: string;
      enabled?: boolean;
      /** A checked item shows its check mark instead of the icon. */
      checked?: boolean;
      role?: MenuRole;
      icon?: DesktopIcon;
      /**
       * Runs when the item is chosen, in the menu that was opened from this
       * array. The menu's own result, the item's `id`, is reported as well.
       */
      onPress?: () => void;
    }
  | {
      type: 'submenu';
      id?: string;
      label: string;
      enabled?: boolean;
      items: MenuItemSpec[];
      /** Drawn by the custom and GPUI-drawn menus; native submenus have none. */
      icon?: DesktopIcon;
    }
  | { type: 'separator' }
  | { type: 'role'; role: MenuRole; label?: string; enabled?: boolean };

export interface MenuPressEvent {
  id: string;
  windowId: number;
}

export interface MenuItemPatch {
  label?: string;
  enabled?: boolean;
  checked?: boolean;
}

export interface MenuDescription {
  appName: string;
  userSet: boolean;
  items: MenuItemSpec[];
  /** Whether the main window's menu bar is shown. Always true on macOS. */
  menuBarVisible: boolean;
}

const MENU_PRESS = 'gpuiDesktop:menuPress';

/** The URI the native side loads an icon from. */
export function iconUri(icon: DesktopIcon | undefined): string | undefined {
  if (icon == null) {
    return undefined;
  }
  if (typeof icon === 'string') {
    return icon;
  }
  const source = Array.isArray(icon) ? icon[0] : icon;
  return source == null ? undefined : Image.resolveAssetSource(source)?.uri;
}

/** A menu as the native presenters read it: each icon as a URI. */
export function nativeMenuItems(items: MenuItemSpec[]): Object[] {
  return items.map(item => {
    if (item.type === 'separator' || item.type === 'role') {
      return item;
    }
    const { icon, ...rest } = item;
    if ('onPress' in rest) {
      delete rest.onPress;
    }
    const uri = iconUri(icon);
    const native: { [key: string]: unknown } = uri
      ? { ...rest, icon: uri }
      : rest;
    if (item.type === 'submenu') {
      native.items = nativeMenuItems(item.items);
    }
    return native;
  });
}

/** The `onPress` handlers of the items of a menu, by item id. */
export type MenuHandlers = Map<string, () => void>;

/**
 * Collects the `onPress` handlers of a menu tree by item id, and returns the
 * tree without them, which is what the native and custom menus take.
 */
export function collectMenuHandlers(
  items: MenuItemSpec[],
  handlers: MenuHandlers = new Map(),
): { items: MenuItemSpec[]; handlers: MenuHandlers } {
  const stripped = items.map((item): MenuItemSpec => {
    if (item.type === 'separator' || item.type === 'role') {
      return item;
    }
    if (item.type === 'submenu') {
      return {
        ...item,
        items: collectMenuHandlers(item.items, handlers).items,
      };
    }
    const { onPress, ...rest } = item;
    if (onPress) {
      handlers.set(item.id, onPress);
    }
    return rest;
  });
  return { items: stripped, handlers };
}

let applicationMenuHandlers: MenuHandlers = new Map();
let dockMenuHandlers: MenuHandlers = new Map();
let applicationMenuListening = false;

function listenForMenuPresses() {
  if (applicationMenuListening) {
    return;
  }
  applicationMenuListening = true;
  DeviceEventEmitter.addListener(MENU_PRESS, payload => {
    const id = (payload as MenuPressEvent | undefined)?.id;
    if (id != null) {
      (applicationMenuHandlers.get(id) ?? dockMenuHandlers.get(id))?.();
    }
  });
}

/** Makes `items`' handlers the ones a press of the application menu runs. */
export function setApplicationMenuHandlers(items: MenuItemSpec[] | null) {
  applicationMenuHandlers = items
    ? collectMenuHandlers(items).handlers
    : new Map();
  listenForMenuPresses();
}

/** Hearers of `Menu.setMenuBarVisible` for the main window. */
const menuBarVisibility = new Set<(visible: boolean) => void>();

/**
 * Whether the main window's in-window menu bar is shown, following
 * `Menu.setMenuBarVisible` and the `window.menuBar` setting.
 */
export function useMenuBarVisible(): boolean {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    let alive = true;
    Menu.get().then(
      description => {
        if (alive) setVisible(description.menuBarVisible);
      },
      () => {},
    );
    menuBarVisibility.add(setVisible);
    return () => {
      alive = false;
      menuBarVisibility.delete(setVisible);
    };
  }, []);
  return visible;
}

export const Menu = {
  /**
   * Replace the application menu. `null` restores the default menu (app menu,
   * Edit, Window, Help).
   */
  setApplicationMenu(items: MenuItemSpec[] | null): Promise<void> {
    setApplicationMenuHandlers(items);
    return request(native =>
      native.menuSetApplicationMenu(items ? nativeMenuItems(items) : null),
    );
  },

  /**
   * Sets the menu of the Dock icon, shown above the system's own items when the
   * icon is right-clicked. macOS only; elsewhere it does nothing. `null` removes
   * it. An item's `onPress` runs when it is chosen, and the press is reported to
   * `addListener('press')` like the application menu's.
   */
  setDockMenu(items: MenuItemSpec[] | null): Promise<void> {
    dockMenuHandlers = items ? collectMenuHandlers(items).handlers : new Map();
    listenForMenuPresses();
    return request(native =>
      native.menuSetDockMenu(items ? nativeMenuItems(items) : null),
    );
  },

  update(id: string, patch: MenuItemPatch): Promise<void> {
    return request(native => native.menuUpdate(id, patch));
  },

  get(): Promise<MenuDescription> {
    return request(native => native.menuGet()) as Promise<MenuDescription>;
  },

  /**
   * Hides or shows the menu bar drawn inside the window.
   *
   * A no-op on macOS, where the bar is the system's; use the `menuBarInWindow`
   * capability to hide your own UI instead of asking for something that cannot
   * happen. Accelerators keep working either way, because they are key bindings
   * rather than menu-widget shortcuts. `windowId` defaults to the main window.
   */
  /**
   * Runs a standard menu role, as a native menu item would.
   *
   * A custom menu drawn in React is ordinary views, so its role items (`copy`,
   * `paste`, …) need this to do anything.
   */
  performRole(role: MenuRoleAction): Promise<void> {
    return request(native => native.menuPerformRole(role));
  },

  setMenuBarVisible(visible: boolean, windowId?: number): Promise<void> {
    return request(native =>
      native.menuSetMenuBarVisible(visible, windowId),
    ).then(() => {
      if (windowId == null) {
        menuBarVisibility.forEach(listener => listener(visible));
      }
    });
  },

  /**
   * Draws the in-window menu bar over a room your layout keeps for it, in
   * window coordinates, in place of the strip at the top of the window.
   * `TitleBar` does this for you. A no-op where the bar is the system's.
   */
  setMenuBarSlot(
    slot: { x: number; y: number; width: number; height: number },
    colors: { foreground: number; hover: number },
    windowId?: number,
  ): Promise<void> {
    return request(native =>
      native.menuSetMenuBarSlot(
        slot.x,
        slot.y,
        slot.width,
        slot.height,
        colors.foreground,
        colors.hover,
        windowId,
      ),
    );
  },

  /** Gives the menu bar its own strip at the top of the window again. */
  clearMenuBarSlot(windowId?: number): Promise<void> {
    return request(native => native.menuClearMenuBarSlot(windowId));
  },

  addListener(
    event: 'press',
    listener: (event: MenuPressEvent) => void,
  ): Subscription {
    if (event !== 'press') {
      throw new Error(`Menu.addListener: unknown event ${String(event)}`);
    }
    const emitter = DeviceEventEmitter.addListener(MENU_PRESS, payload => {
      listener((payload ?? {}) as MenuPressEvent);
    });
    return { remove: () => emitter.remove() };
  },
};

export interface ApplicationMenuProps {
  items: MenuItemSpec[] | null;
  onPress?: (event: MenuPressEvent) => void;
}

/**
 * Declarative menu: sets the menu on mount and on change, restores the previous
 * menu on unmount, and patches single-item changes instead of rebuilding.
 */
export function ApplicationMenu({ items, onPress }: ApplicationMenuProps) {
  const restore = React.useRef<MenuItemSpec[] | null>(null);
  const last = React.useRef<MenuItemSpec[] | null>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (onPress) {
      const subscription = Menu.addListener('press', onPress);
      return () => subscription.remove();
    }
    return undefined;
  }, [onPress]);

  React.useEffect(() => {
    let cancelled = false;
    Menu.get()
      .then(current => {
        if (!cancelled) {
          restore.current = current?.items ?? null;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!ready) {
      return;
    }
    const previous = last.current;
    const patches =
      previous != null && items != null ? diffItems(previous, items) : null;
    if (patches) {
      setApplicationMenuHandlers(items);
      // A rejected menu call would otherwise be an unhandled rejection with
      // nothing to show for it: the menu simply would not match the props. Log it
      // and carry on, the same way `ContextMenuView` does.
      for (const patch of patches) {
        Menu.update(patch.id, patch.patch).catch(error => {
          console.warn('ApplicationMenu: failed to update a menu item', error);
        });
      }
    } else {
      Menu.setApplicationMenu(items).catch(error => {
        console.warn(
          'ApplicationMenu: failed to set the application menu',
          error,
        );
      });
    }
    last.current = items;
  }, [items, ready]);

  React.useEffect(() => {
    return () => {
      Menu.setApplicationMenu(restore.current).catch(error => {
        console.warn(
          'ApplicationMenu: failed to restore the default menu',
          error,
        );
      });
    };
  }, []);

  return null;
}

interface ItemPatch {
  id: string;
  patch: MenuItemPatch;
}

/**
 * When two menus have the same shape (same ids, same nesting), return the
 * per-item patches; otherwise `null` meaning "rebuild".
 */
export function diffItems(
  before: MenuItemSpec[],
  after: MenuItemSpec[],
): ItemPatch[] | null {
  const patches: ItemPatch[] = [];
  if (!diffLevel(before, after, patches)) {
    return null;
  }
  return patches;
}

function diffLevel(
  before: MenuItemSpec[],
  after: MenuItemSpec[],
  patches: ItemPatch[],
): boolean {
  if (before.length !== after.length) {
    return false;
  }
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (previous.type !== next.type) {
      return false;
    }
    if (previous.type === 'submenu' && next.type === 'submenu') {
      if (previous.id !== next.id || previous.label !== next.label) {
        return false;
      }
      if (!diffLevel(previous.items, next.items, patches)) {
        return false;
      }
      continue;
    }
    if (previous.type === 'separator' && next.type === 'separator') {
      continue;
    }
    const previousItem = previous as { id?: string; label?: string };
    const nextItem = next as {
      id?: string;
      label?: string;
      enabled?: boolean;
      checked?: boolean;
    };
    if (previousItem.id !== nextItem.id) {
      return false;
    }
    if (previousItem.id != null) {
      const patch: MenuItemPatch = {};
      if (previousItem.label !== nextItem.label) {
        patch.label = nextItem.label;
      }
      const beforeEnabled = (previous as { enabled?: boolean }).enabled ?? true;
      const afterEnabled = nextItem.enabled ?? true;
      if (beforeEnabled !== afterEnabled) {
        patch.enabled = afterEnabled;
      }
      const beforeChecked =
        (previous as { checked?: boolean }).checked ?? false;
      const afterChecked = nextItem.checked ?? false;
      if (beforeChecked !== afterChecked) {
        patch.checked = afterChecked;
      }
      if (Object.keys(patch).length > 0) {
        patches.push({ id: previousItem.id, patch });
      }
    }
  }
  return true;
}
