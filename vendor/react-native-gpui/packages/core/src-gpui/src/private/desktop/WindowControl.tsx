/**
 * A caption button: minimize, maximize/restore, or close.
 *
 * Not a `Pressable`. The action runs natively, so closing and minimizing work
 * while JS is busy, and on Windows the area takes part in the OS hit-test, which
 * is what gives the snap-layout flyout. `style` and `children` may be functions of
 * the control's state, like `Pressable`.
 *
 * @format
 */

import React from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import NativeWindowControl from '../specs/DesktopWindowControlNativeComponent';
import { useDesktopWindowId } from './windowContext';
import { DesktopWindow } from './windows';

export type WindowControlAction = 'minimize' | 'maximize' | 'close';

export interface WindowControlState {
  hovered: boolean;
  pressed: boolean;
  /** Whether the window is maximized, so the glyph can switch to "restore". */
  maximized: boolean;
}

export interface WindowControlProps {
  action: WindowControlAction;
  disabled?: boolean;
  /**
   * Styles, or a function of the state. The state drives appearance only; it
   * never decides whether the action runs.
   */
  style?:
    | StyleProp<ViewStyle>
    | ((state: WindowControlState) => StyleProp<ViewStyle>);
  children?: React.ReactNode | ((state: WindowControlState) => React.ReactNode);
  testID?: string;
}

const INITIAL: WindowControlState = {
  hovered: false,
  pressed: false,
  maximized: false,
};

export function WindowControl({
  action,
  disabled = false,
  style,
  children,
  testID,
}: WindowControlProps) {
  const [state, setState] = React.useState<WindowControlState>(INITIAL);
  const windowId = useDesktopWindowId();

  // `maximized` follows the window, not just this button: the press and hover
  // events carry it, but a window maximized any other way — a double click on
  // the title bar, Win+Up, a snap — sends neither, and the maximize glyph has to
  // turn into the restore glyph all the same.
  React.useEffect(() => {
    const desktopWindow = new DesktopWindow(windowId);
    let alive = true;
    const follow = (maximized: boolean) =>
      setState(previous =>
        previous.maximized === maximized
          ? previous
          : { ...previous, maximized },
      );
    desktopWindow.getState().then(
      current => {
        if (alive) follow(current.isMaximized);
      },
      () => {},
    );
    const subscription = desktopWindow.addListener('stateChange', event => {
      if (typeof event.isMaximized === 'boolean') follow(event.isMaximized);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [windowId]);

  // On a platform without the desktop shell the component is not registered, so
  // fall back to a plain View: the app still renders and the button does nothing,
  // which is what a caption button can mean there.
  if (NativeWindowControl == null) {
    return (
      <View
        style={typeof style === 'function' ? style(INITIAL) : style}
        testID={testID}
      >
        {typeof children === 'function' ? children(INITIAL) : children}
      </View>
    );
  }

  return (
    <NativeWindowControl
      action={action}
      disabled={disabled}
      style={typeof style === 'function' ? style(state) : style}
      testID={testID}
      onControlStateChange={event => {
        const next = event.nativeEvent;
        // Only on change: the state is what a re-render is for, and a pointer
        // move that changed nothing must not cause one.
        setState(previous =>
          previous.hovered === next.hovered &&
          previous.pressed === next.pressed &&
          previous.maximized === next.maximized
            ? previous
            : {
                hovered: next.hovered,
                pressed: next.pressed,
                maximized: next.maximized,
              },
        );
      }}
    >
      {typeof children === 'function' ? children(state) : children}
    </NativeWindowControl>
  );
}
