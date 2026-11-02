/**
 * `react-native-gpui/desktop` — the desktop-shell public API.
 *
 * ```ts
 * import {Desktop} from '@react-native-gpui/core/desktop';
 * ```
 *
 * `Menu`, `ContextMenu`, `Tray`, `DesktopWindow` and `PerfMonitor` are added by
 * the feature steps; `Desktop` covers app info and capability checks. Each of
 * them calls a method of the `GpuiDesktop` TurboModule, whose spec lists every
 * command the shell accepts.
 *
 * @format
 */

export {
  capabilities,
  DesktopError,
  desktopModule,
  isDesktopAvailable,
  platform,
  request,
} from './src-gpui/src/private/desktop';

export type {
  DesktopCapabilities,
  DesktopErrorCode,
} from './src-gpui/src/private/desktop';

export {
  DesktopWindow,
  useDesktopWindow,
} from './src-gpui/src/private/desktop/windows';

export type {
  OpenWindowOptions,
  Subscription,
  WindowBounds,
  WindowEvent,
  WindowEventName,
  WindowState,
} from './src-gpui/src/private/desktop/windows';

export {
  installDesktopWindowContext,
  MAIN_WINDOW_ID,
  useDesktopWindowId,
} from './src-gpui/src/private/desktop/windowContext';

export { TitleBar } from './src-gpui/src/private/desktop/TitleBar';
export { WindowControl } from './src-gpui/src/private/desktop/WindowControl';

export type { TitleBarProps } from './src-gpui/src/private/desktop/TitleBar';
export type {
  WindowControlAction,
  WindowControlProps,
  WindowControlState,
} from './src-gpui/src/private/desktop/WindowControl';

export { ApplicationMenu, Menu } from './src-gpui/src/private/desktop/menu';

export {
  ContextMenu,
  ContextMenuView,
} from './src-gpui/src/private/desktop/contextMenu';

export { PerfMonitor } from './src-gpui/src/private/desktop/perfMonitor';

export {
  shortcutId,
  Shortcut,
  Shortcuts,
} from './src-gpui/src/private/desktop/shortcuts';

export {
  ShortcutScope,
  useShortcut,
  useShortcutScope,
} from './src-gpui/src/private/desktop/useShortcut';

export type {
  InstalledShortcut,
  ShortcutDefinition,
  ShortcutEvent,
  ShortcutHandler,
  ShortcutResolution,
} from './src-gpui/src/private/desktop/shortcuts';

export type {
  ShortcutOptions,
  ShortcutScopeProps,
} from './src-gpui/src/private/desktop/useShortcut';

export { Tray } from './src-gpui/src/private/desktop/tray';

export type {
  TrayOptions,
  TrayState,
} from './src-gpui/src/private/desktop/tray';

export type { PerfMetrics } from './src-gpui/src/private/desktop/perfMonitor';

export type {
  DesktopContextMenuEvent,
  DesktopContextMenuEventData,
} from './types';
export type {
  ContextMenuOpenEvent,
  ContextMenuOptions,
  ContextMenuPresentation,
  ContextMenuViewProps,
} from './src-gpui/src/private/desktop/contextMenu';

export type {
  ApplicationMenuProps,
  DesktopIcon,
  MenuDescription,
  MenuItemPatch,
  MenuItemSpec,
  MenuPressEvent,
  MenuRole,
} from './src-gpui/src/private/desktop/menu';

// The augmentation lives in the published `types.d.ts`, which an app's
// `react-native-gpui-env.d.ts` references. Importing it here as well means an app
// that imports this desktop entry needs nothing further.
import type {} from './types';

import { capabilities, request } from './src-gpui/src/private/desktop';
import type { DesktopAppInfo } from './src-gpui/src/private/specs/NativeGpuiDesktop';

export type { DesktopAppInfo };

export const Desktop = {
  getInfo: () => request(native => native.appInfo()),
  capabilities,
};
