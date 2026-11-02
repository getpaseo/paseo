/**
 * A view whose context menu opens natively, with no trip through JS.
 *
 * The menu model is the same `MenuItemSpec[]` every other menu API takes. It is
 * typed `UnsafeMixed` because codegen cannot express a recursive `submenu`; it
 * reaches C++ as `folly::dynamic` and Rust as JSON, where `menu_model` already
 * knows how to read it.
 *
 * The name must end in `NativeComponent.ts`: React Native's babel plugin turns
 * any such file into a static view config, which is how core's other
 * hand-registered host components (`DesktopWindowControl`) work too.
 *
 * @format
 */

import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

/** The item that was chosen. */
type SelectEvent = Readonly<{ id: string }>;

/**
 * The menu opened. The payload is the same data `onContextMenu` reports, so the
 * component can keep that prop working on this path: the native side knows the
 * trigger, where it happened and which modifiers were held, and fabricating any
 * of it in JS would be a lie to the handler.
 */
type OpenEvent = Readonly<{
  x: CodegenTypes.Double;
  y: CodegenTypes.Double;
  pageX: CodegenTypes.Double;
  pageY: CodegenTypes.Double;
  windowId: CodegenTypes.Int32;
  button: CodegenTypes.Int32;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  trigger: string;
}>;

export interface NativeProps extends ViewProps {
  /** The menu model, a `MenuItemSpec[]`. */
  items: CodegenTypes.UnsafeMixed;
  /**
   * `custom` is drawn by JS, so this path leaves it to the descending `View`;
   * `default` and `native` both open the platform's menu.
   */
  presentation?: CodegenTypes.WithDefault<
    'default' | 'native' | 'custom',
    'default'
  >;
  /** Opens nothing at all, and stops claiming the press for a menu. */
  disabled?: CodegenTypes.WithDefault<boolean, false>;
  onMenuSelect?: CodegenTypes.DirectEventHandler<SelectEvent>;
  onMenuOpen?: CodegenTypes.DirectEventHandler<OpenEvent>;
  onMenuDismiss?: CodegenTypes.DirectEventHandler<null>;
}

export default codegenNativeComponent<NativeProps>('DesktopContextMenuView');
