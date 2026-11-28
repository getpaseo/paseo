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
  /** Whether a window can be shown on every Space or workspace. */
  visibleOnAllWorkspaces: boolean;
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

export type PlatformConstants = {
  osVersion: string;
  isTesting: boolean;
};

export interface Spec extends TurboModule {
  /** Read synchronously; these never touch the GPUI main thread. */
  capabilities(): DesktopCapabilities;
  platform(): string;
  /**
   * Where the window's caption buttons sit, as a GTK `button-layout` string such
   * as `appmenu:minimize,maximize,close`. Linux reads it from the desktop; other
   * platforms answer the GTK default.
   */
  windowButtonLayout(): string;
  /**
   * The icon theme's caption button icon (`close`, `minimize`, `maximize` or
   * `restore`) as an SVG data URI painted in `color` (`#rrggbb`), or an empty
   * string when the theme has none. Linux only.
   */
  windowButtonIcon(action: string, color: string): string;
  appId(): string;
  platformConstants(): PlatformConstants;

  appInfo(): Promise<DesktopAppInfo>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiDesktop');
