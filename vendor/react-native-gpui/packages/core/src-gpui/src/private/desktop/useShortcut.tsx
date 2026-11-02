/**
 * `useShortcut` and `<ShortcutScope>` — keyboard shortcuts, as a hook.
 *
 * ```tsx
 * function Editor() {
 *   useShortcut('mod+s', save, { when: 'editor', description: 'Save' });
 *   return <TextArea />;
 * }
 *
 * <ShortcutScope name="editor">
 *   <Editor />
 * </ShortcutScope>
 * ```
 *
 * The handler runs in the scope the hook was called in. Scopes nest, the
 * innermost wins, and a shortcut beats a menu accelerator with the same keys,
 * because the keymap consumes the key before either the text input or the menu
 * sees it. See `shortcuts.ts` for the precedence and `desktop/keymap.rs` for why
 * the native ordering is what makes it work.
 *
 * @format
 */

import React from 'react';
import NativeShortcutScope from '../specs/DesktopShortcutScopeNativeComponent';
import {
  addHandler,
  type ShortcutEvent,
  type ShortcutHandler,
  register,
  shortcutId,
  unregister,
} from './shortcuts';

export { shortcutId };

/** The scope name the nearest `<ShortcutScope>` provides. */
export const ShortcutScopeContext = React.createContext<string | undefined>(
  undefined,
);

/** The scope this component is inside, or `undefined` at the window level. */
export function useShortcutScope(): string | undefined {
  return React.useContext(ShortcutScopeContext);
}

export interface ShortcutOptions {
  /** Register in this scope instead of the nearest one. */
  when?: string;
  /** Whether the shortcut is live. Defaults to true. */
  enabled?: boolean;
  /**
   * Whether it still fires while a text input has focus. Defaults to false,
   * which leaves typing, selection and the editing keys to the input.
   */
  allowInTextInput?: boolean;
  /**
   * Whether a held key fires repeatedly. Defaults to false: a shortcut that
   * saves, or opens a sheet, must run once per press. Native suppresses the
   * repeats when this is false.
   */
  repeat?: boolean;
  /** Shown in a menu or a settings list. */
  description?: string;
}

/**
 * Registers `handler` for `keys` in the nearest scope.
 *
 * The shortcut's id is derived from the keys and the scope, so two components
 * that ask for the same keys in the same scope share one shortcut and both
 * handlers run — which is what a menu item and a component means when they
 * register the same thing. Pass `options.when` and an explicit id through
 * `Shortcuts.register` when a stable name matters (a menu accelerator, a user
 * keymap).
 *
 * The handler is kept in a ref, so a handler that closes over changing state does
 * not re-register the shortcut on every render.
 */
export function useShortcut(
  keys: string,
  handler: ShortcutHandler,
  options: ShortcutOptions = {},
): void {
  const nearest = useShortcutScope();
  const scope = options.when ?? nearest;
  const {
    enabled = true,
    allowInTextInput = false,
    repeat = false,
    description,
  } = options;

  // The id is stable across renders, and distinct per scope: the same keys in
  // two scopes are two shortcuts, because that is what makes an override work.
  const id = React.useMemo(() => shortcutId(keys, scope), [keys, scope]);

  const latest = React.useRef(handler);
  latest.current = handler;

  React.useEffect(() => {
    return addHandler(id, event => latest.current(event));
  }, [id]);

  React.useEffect(() => {
    register([
      {
        id,
        keys,
        when: scope,
        enabled,
        allowInTextInput,
        description,
      },
    ]);
    return () => unregister(id);
  }, [id, keys, scope, enabled, allowInTextInput, description]);

  // `repeat` is not part of the native binding: it is a property of the action,
  // not of the key. Native suppresses a held key's repeats unless the shortcut
  // asks for them, and the registry says which ones asked.
  React.useEffect(() => {
    setRepeat(id, repeat);
    return () => setRepeat(id, undefined);
  }, [id, repeat]);
}

/** Which shortcuts asked for key repeats. */
const repeating = new Set<string>();

function setRepeat(id: string, repeat: boolean | undefined): void {
  if (repeat === true) {
    repeating.add(id);
  } else {
    repeating.delete(id);
  }
}

/** Whether `id` asked for repeats. Read by the bridge when it fires a handler. */
export function wantsRepeat(id: string): boolean {
  return repeating.has(id);
}

export interface ShortcutScopeProps {
  /** The name a `useShortcut`'s `when` refers to. */
  name: string;
  children?: React.ReactNode;
  style?: React.ComponentProps<typeof NativeShortcutScope>['style'];
  testID?: string;
}

/**
 * A named scope for the shortcuts inside it.
 *
 * Not a perceptible container: this is a `View` that carries a name, so it takes
 * part in layout exactly as a `View` would. On a platform without the desktop
 * shell it falls back to one, and shortcuts inside it simply never fire.
 */
export function ShortcutScope({
  name,
  children,
  style,
  testID,
}: ShortcutScopeProps) {
  if (NativeShortcutScope == null) {
    return (
      <ShortcutScopeContext.Provider value={name}>
        <FallbackView style={style} testID={testID}>
          {children}
        </FallbackView>
      </ShortcutScopeContext.Provider>
    );
  }
  return (
    <ShortcutScopeContext.Provider value={name}>
      <NativeShortcutScope
        name={name}
        style={style}
        testID={testID}
        onShortcut={event => {
          // Native already decided this shortcut belongs to this scope, and
          // consumed the key. The registry owns the handlers, so it only has to
          // run them.
          fireShortcut(event.nativeEvent.id);
        }}
      >
        {children}
      </NativeShortcutScope>
    </ShortcutScopeContext.Provider>
  );
}

/** The fallback container, resolved lazily for the same reason the bridge is. */
function FallbackView({
  style,
  testID,
  children,
}: {
  style?: ShortcutScopeProps['style'];
  testID?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const { View } = require('react-native');
  return (
    <View style={style} testID={testID}>
      {children}
    </View>
  );
}

// A local indirection so this module does not import `fire` under a name that
// suggests the wrong direction: native fired it, we forward it.
function fireShortcut(id: string): void {
  const { fire } = require('./shortcuts') as typeof import('./shortcuts');
  fire(id);
}

/** The event a `ShortcutHandler` receives, re-exported for convenience. */
export type { ShortcutEvent, ShortcutHandler };
