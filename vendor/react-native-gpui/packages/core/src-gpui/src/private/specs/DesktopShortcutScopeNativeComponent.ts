/**
 * A named scope for keyboard shortcuts, as a native host component.
 *
 * Scopes nest and the innermost one wins. The precedence is resolved natively
 * by GPUI's keymap — a binding whose context names a deeper scope matches at a
 * greater depth — so this component only has to name itself and pass on what
 * fired.
 *
 * The name must end in `NativeComponent.ts`: React Native's babel plugin turns
 * any such file into a static view config, which is how core's other
 * hand-registered host component (`WindowControl`) works too.
 * Core has no component codegen, so the props, the descriptor and the props
 * reader are all hand-written; see
 * `ReactCxxPlatform/react/renderer/components/shortcutscope/`.
 *
 * @format
 */

import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

/**
 * A shortcut that fired inside this scope.
 *
 * `keys` is the shortcut's binding as the registry knows it, so a handler can
 * tell a remapped shortcut from the one it was written against.
 */
export type ShortcutEvent = Readonly<{
  id: string;
}>;

export interface NativeProps extends ViewProps {
  /** The name a `useShortcut`'s `when` refers to. */
  name: string;
  /** Fires for a shortcut registered in this scope, and in no inner one. */
  onShortcut?: CodegenTypes.DirectEventHandler<ShortcutEvent>;
}

export default codegenNativeComponent<NativeProps>('DesktopShortcutScope');
