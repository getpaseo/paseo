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
  menuGet(): Promise<MenuDescription>;
  /** Hides or shows the in-window menu bar. A no-op on macOS. */
  menuSetMenuBarVisible(visible: boolean, windowId?: number): Promise<void>;
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
