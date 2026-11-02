/**
 * The React context that tells a window's JS which window it is.
 *
 * `AppRegistry` renders the app's root component with the surface's
 * `initialProps`, and the host passes `windowId` in them. A wrapper component
 * installed through RN's public `setWrapperComponentProvider` turns that into a
 * context value, so `DesktopWindow.current()` needs no global mutable state
 * (which would be unsafe with two windows rendering in one JS runtime).
 *
 * @format
 */

import React, { createContext, useContext } from 'react';
import { AppRegistry } from 'react-native';
import { ContextMenuHost } from './contextMenu/ContextMenuHost';
import { installPerfMonitorBridge } from './perfMonitor';
import { installBridge as installShortcutBridge } from './shortcuts';

export const MAIN_WINDOW_ID = 1;

export const DesktopWindowContext = createContext<number>(MAIN_WINDOW_ID);

export function useDesktopWindowId(): number {
  return useContext(DesktopWindowContext);
}

let installed = false;

export function installDesktopWindowContext(): void {
  if (installed) {
    return;
  }
  installed = true;
  AppRegistry.setWrapperComponentProvider(() => {
    function DesktopWindowWrapper(props: {
      initialProps?: { windowId?: number };
      children?: React.ReactNode;
    }) {
      const raw = props?.initialProps?.windowId;
      const windowId =
        typeof raw === 'number' && raw > 0 ? raw : MAIN_WINDOW_ID;
      // The app root renders once `react-native` is initialized, which is the
      // first point where the device-event emitter can be reached (the Perf
      // Monitor follows native toggles from the Dev Menu through it).
      installPerfMonitorBridge();
      // Shortcuts with no scope element report as a device event; the listener
      // has to exist before the first key is pressed.
      installShortcutBridge();
      // The custom context menu's host rides along here rather than in each app:
      // it renders nothing until a menu opens, and mounting it in the wrapper is
      // what gives every window one without the app adding anything.
      return React.createElement(
        DesktopWindowContext.Provider,
        { value: windowId },
        props.children,
        React.createElement(ContextMenuHost),
      );
    }
    return DesktopWindowWrapper;
  });
}
