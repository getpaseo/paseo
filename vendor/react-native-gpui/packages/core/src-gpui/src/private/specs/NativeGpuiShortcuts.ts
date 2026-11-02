import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * One shortcut, as the registry flattens it.
 *
 * `keys` is the JS spelling (`mod+s`, `mod+k mod+s`); native normalises it, so
 * the parse rules live in one place and a test can check them without JS.
 */
export type ShortcutSpec = {
  id: string;
  keys: string;
  /** The `ShortcutScope` it belongs to; unset is the window/app scope. */
  scope?: string;
  enabled: boolean;
  /** Whether it still fires while a text input has focus. */
  allowInTextInput: boolean;
};

export type ShortcutInstallResult = {
  installed: number;
};

export interface Spec extends TurboModule {
  /**
   * Replaces the installed set. Reinstalling the same set is a no-op, so a
   * re-render that recomputes the list does not rebuild the keymap.
   */
  shortcutInstall(
    shortcuts: Array<ShortcutSpec>,
  ): Promise<ShortcutInstallResult>;
  /** What is installed now, as native normalised it. */
  shortcutGet(): Promise<Array<ShortcutSpec>>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiShortcuts');
