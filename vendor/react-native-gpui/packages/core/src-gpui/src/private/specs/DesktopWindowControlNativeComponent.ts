/**
 * A caption button, as a native host component.
 *
 * A `WindowControl` is a specific widget rather than a property of an arbitrary
 * box: it carries its own hover and pressed state, and the press must reach
 * native even while JS is busy. That is why it is a component and not the
 * `desktopWindowControl` prop it replaces.
 *
 * The name must end in `NativeComponent.ts`: React Native's babel plugin turns any
 * such file into a static view config, which is how core's other hand-registered
 * host components (`NativeViewHost`) work too.
 *
 * @format
 */

import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

/** The control's state, so an app can restyle without asking the window. */
export type ControlStateEvent = Readonly<{
  hovered: boolean;
  pressed: boolean;
  maximized: boolean;
}>;

export interface NativeProps extends ViewProps {
  /** What a completed press does. `close` still goes through `closeRequested`. */
  action?: CodegenTypes.WithDefault<'minimize' | 'maximize' | 'close', 'close'>;
  /** Disables the button: no hover, no press, and no window-control area. */
  disabled?: CodegenTypes.WithDefault<boolean, false>;
  onControlStateChange?: CodegenTypes.DirectEventHandler<ControlStateEvent>;
}

export default codegenNativeComponent<NativeProps>('DesktopWindowControl');
