import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type MenuItemPatch = {
  label?: string;
  enabled?: boolean;
  checked?: boolean;
};

export type MenuDescription = {
  appName: string;
  userSet: boolean;
  items: Array<Object>;
  /** Whether the main window's menu bar is shown. Always true on macOS. */
  menuBarVisible: boolean;
};

export interface Spec extends TurboModule {
  menuSetApplicationMenu(items: Array<Object> | null): Promise<void>;
  menuUpdate(id: string, patch: MenuItemPatch): Promise<void>;
  /** Sets the menu of the Dock icon (macOS), or removes it with `null`. */
  menuSetDockMenu(items: Array<Object> | null): Promise<void>;
  menuGet(): Promise<MenuDescription>;
  /** Hides or shows the in-window menu bar. A no-op on macOS. */
  menuSetMenuBarVisible(visible: boolean, windowId?: number): Promise<void>;
  /**
   * Draws the in-window menu bar over a room the React tree reserved for it, in
   * window coordinates, instead of in a strip at the top of the window. The
   * colours are `processColor` values.
   */
  menuSetMenuBarSlot(
    x: number,
    y: number,
    width: number,
    height: number,
    foreground: number,
    hover: number,
    windowId?: number,
  ): Promise<void>;
  /** Gives the menu bar its own strip at the top of the window again. */
  menuClearMenuBarSlot(windowId?: number): Promise<void>;
  /**
   * Runs a standard menu role, as a native menu item would.
   *
   * A custom menu drawn in React is ordinary views, so this is the only thing
   * that performs its role items.
   */
  menuPerformRole(role: string): Promise<void>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiAppMenu');
