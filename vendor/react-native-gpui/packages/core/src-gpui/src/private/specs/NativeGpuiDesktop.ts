/**
 * Core desktop-shell TurboModule.
 *
 * Every desktop-shell command is a method here, with the arguments and results
 * the JS API uses. `rn-gpui` implements the trait generated from this file, so
 * the two sides cannot drift, and each command runs on the GPUI main thread.
 * The public JS modules (`Menu`, `ContextMenu`, `Tray`, `DesktopWindow`,
 * `PerfMonitor`) are typed wrappers over these methods.
 *
 * Events are not typed events: the shell reports window, menu and tray activity
 * as device events (`gpuiDesktop:*`), which the wrappers subscribe to with
 * `DeviceEventEmitter`. `addListener`/`removeListeners` exist for that channel.
 *
 * The JS side only imports this file's types, so `getEnforcing` cannot throw
 * during startup.
 *
 * @format
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type DesktopCapabilities = {
  nativeAppMenu: boolean;
  nativeContextMenu: boolean;
  tray: boolean;
  trayPopoverAnchored: boolean;
  windowPosition: boolean;
  alwaysOnTop: boolean;
  transparentTitlebar: boolean;
  /**
   * Whether a frameless window can still be resized, so an app may draw its own
   * caption buttons. Always true on macOS and Windows; on Linux it follows what
   * the compositor granted the newest window.
   */
  clientDecorations: boolean;
  /** Whether the menu bar is drawn in the window, so hiding it does anything. */
  menuBarInWindow: boolean;
};

export type DesktopAppInfo = {
  platform: string;
  arch: string;
  capabilities: DesktopCapabilities;
};

export interface Spec extends TurboModule {
  /** Read synchronously; these never touch the GPUI main thread. */
  capabilities(): DesktopCapabilities;
  platform(): string;
  appId(): string;

  appInfo(): Promise<DesktopAppInfo>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiDesktop');
