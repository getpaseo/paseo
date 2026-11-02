/**
 * `Shortcuts` — the keyboard-shortcut registry.
 *
 * Every shortcut lives in the nearest `<ShortcutScope>`, and the precedence is
 * resolved natively by GPUI's keymap: a binding whose context names a deeper
 * scope matches at a greater depth, so an inner scope overrides an outer one
 * without any of that ordering living here. What this module owns is the list
 * JS declares and the handlers that run when one fires.
 *
 * The scope tree is:
 *
 * ```
 * TextInput editing keys (unless allowInTextInput)
 *   -> innermost ShortcutScope
 *   -> outer ShortcutScopes
 *   -> window scope (no wrapper)
 *   -> menu accelerators
 * ```
 *
 * A shortcut is identified by a stable `id`, so a user keymap can remap it, a
 * menu item can name it instead of a literal accelerator, and several handlers
 * can be attached to one shortcut.
 *
 * @format
 */

import NativeGpuiShortcuts from '../specs/NativeGpuiShortcuts';

/** A shortcut as an app declares it. */
export interface ShortcutDefinition {
  /** Stable name, e.g. `file.save`. Two shortcuts with one id are one shortcut. */
  id: string;
  /** `mod+s`, `mod+k mod+s`. `mod` is Command on macOS and Control elsewhere. */
  keys: string;
  /** The `ShortcutScope` it belongs to. Unset is the window/app scope. */
  when?: string;
  /** Whether it fires at all. Defaults to true. */
  enabled?: boolean;
  /**
   * Whether it still fires while a text input has focus. Defaults to false,
   * which leaves the text input's own editing keys alone.
   */
  allowInTextInput?: boolean;
  /** Shown in a menu or a settings list. */
  description?: string;
}

/** A shortcut as native stores it: `keys` is already normalised. */
export interface InstalledShortcut {
  id: string;
  keys: string;
  scope?: string;
  enabled: boolean;
  allowInTextInput: boolean;
}

export type ShortcutHandler = (event: ShortcutEvent) => void;

export interface ShortcutEvent {
  id: string;
  /** The keys it fired on, after any user remap. */
  keys: string;
  /** The scope that owned it, or `undefined` for the window/app scope. */
  scope?: string;
}

/** What a press would do, without pressing it. */
export interface ShortcutResolution {
  id: string;
  keys: string;
  scope?: string;
}

const NO_SHORTCUTS: ShortcutDefinition[] = [];

/**
 * The installed definitions, keyed by id.
 *
 * A `Map` keeps declaration order, which is the order handlers run in when two
 * shortcuts somehow share a binding: the last declared wins, matching how a
 * keymap treats bindings added later.
 */
const definitions = new Map<string, ShortcutDefinition>();

/** Handlers per shortcut id. A shortcut can have several, like an event. */
const handlers = new Map<string, Set<ShortcutHandler>>();

/**
 * How many callers currently register each id.
 *
 * A component re-registers whenever its options change, and React runs the old
 * effect's cleanup before the new effect. Without a count, that cleanup would
 * delete the shortcut (and the handler the sibling effect owns) and the next
 * effect would put back a shortcut with no handler at all — which is exactly how
 * toggling `allowInTextInput` silently stopped a shortcut firing. The registry
 * removes a definition only when the last owner lets go.
 */
const owners = new Map<string, number>();

/** User remaps: `file.save` -> `mod+shift+s`. */
let userBindings: Record<string, string | null> = {};

let installedSignature = '';
let installScheduled = false;
let nativeBridgeInstalled = false;

/** How many shortcuts are registered. */
export function count(): number {
  return definitions.size;
}

/**
 * The effective keys for a shortcut: a user binding if there is one, otherwise
 * what the app declared. A `null` binding disables it, which is how a user
 * unbinds a shortcut without the app changing.
 */
function effectiveKeys(definition: ShortcutDefinition): string | null {
  if (Object.prototype.hasOwnProperty.call(userBindings, definition.id)) {
    return userBindings[definition.id];
  }
  return definition.keys;
}

/**
 * The flat list native installs, in declaration order.
 *
 * A shortcut with no effective keys is left out rather than installed disabled:
 * native has nothing to bind, and an absent binding cannot shadow another one.
 */
export function list(): InstalledShortcut[] {
  const out: InstalledShortcut[] = [];
  for (const definition of definitions.values()) {
    const keys = effectiveKeys(definition);
    if (keys == null) {
      continue;
    }
    out.push({
      id: definition.id,
      keys,
      scope: definition.when,
      enabled: definition.enabled !== false,
      allowInTextInput: definition.allowInTextInput === true,
    });
  }
  return out;
}

/** The declared definitions, with `keys` replaced by any user binding. */
export function describe(): ShortcutDefinition[] {
  return list().map(installed => {
    const definition = definitions.get(installed.id);
    return {
      ...(definition ?? { id: installed.id, keys: installed.keys }),
      keys: installed.keys,
      when: installed.scope,
      enabled: installed.enabled,
      allowInTextInput: installed.allowInTextInput,
    };
  });
}

/**
 * Registers or replaces shortcuts.
 *
 * Replacing by id rather than appending is what makes this safe to call from a
 * render: a component that recomputes its shortcuts each time ends up with the
 * same registry, not a growing one. A declaration that disappears from the list
 * it was registered with is *not* removed here — `unregister` does that — so two
 * components can each install their own without clobbering the other.
 */
export function register(shortcuts: ShortcutDefinition[]): void {
  let changed = false;
  for (const shortcut of shortcuts) {
    if (shortcut.id === '') {
      throw new Error('a shortcut requires an id');
    }
    if (shortcut.keys.trim() === '' && !hasOwnBinding(shortcut.id)) {
      throw new Error(`shortcut ${shortcut.id} has no keys`);
    }
    const previous = definitions.get(shortcut.id);
    const next: ShortcutDefinition = {
      ...shortcut,
      // Undefined and true mean the same thing; normalise so a re-register that
      // only spelled the default differently is not a change.
      enabled: shortcut.enabled !== false,
      allowInTextInput: shortcut.allowInTextInput === true,
    };
    owners.set(shortcut.id, (owners.get(shortcut.id) ?? 0) + 1);
    if (
      previous == null ||
      previous.keys !== next.keys ||
      previous.when !== next.when ||
      previous.enabled !== next.enabled ||
      previous.allowInTextInput !== next.allowInTextInput ||
      previous.description !== next.description
    ) {
      definitions.set(shortcut.id, next);
      changed = true;
    }
  }
  if (changed) {
    scheduleInstall();
  }
}

function hasOwnBinding(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(userBindings, id);
}

/**
 * Releases one registration of `id`.
 *
 * The definition goes only when the last owner releases it, so a component that
 * re-registers (because an option changed) does not clobber itself. Handlers are
 * *not* touched here: the function `addHandler` returns owns them, and deleting
 * them here would remove a handler that is still mounted.
 */
export function unregister(id: string): void {
  const remaining = (owners.get(id) ?? 1) - 1;
  if (remaining > 0) {
    owners.set(id, remaining);
    return;
  }
  owners.delete(id);
  if (definitions.delete(id)) {
    scheduleInstall();
  }
}

/** Removes every shortcut. Used when an app's own views unmount. */
export function clear(): void {
  if (definitions.size === 0) {
    return;
  }
  definitions.clear();
  handlers.clear();
  owners.clear();
  scheduleInstall();
}

/**
 * Attaches a handler to a shortcut.
 *
 * Several handlers may share an id; they run in the order they were added.
 * Returns a function that removes this handler, which is what a hook returns
 * from its effect.
 */
export function addHandler(id: string, handler: ShortcutHandler): () => void {
  let set = handlers.get(id);
  if (set == null) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(handler);
  return () => {
    const current = handlers.get(id);
    if (current == null) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      handlers.delete(id);
    }
  };
}

/** Runs every handler for `id`. Native calls this when a shortcut fires. */
export function fire(id: string): void {
  const set = handlers.get(id);
  if (set == null) {
    return;
  }
  const installed = list().find(shortcut => shortcut.id === id);
  const event: ShortcutEvent = {
    id,
    keys: installed?.keys ?? definitions.get(id)?.keys ?? '',
    scope: installed?.scope ?? definitions.get(id)?.when,
  };
  // Copied before iterating: a handler that removes itself (the common case for
  // a one-shot shortcut) must not disturb the loop.
  for (const handler of [...set]) {
    handler(event);
  }
}

/**
 * Replaces the user's keymap.
 *
 * `bindings` maps a shortcut id to the keys the user chose, or `null` to unbind
 * it. An id that no app declares is kept: the user bound something that is not
 * installed yet, and it should apply if it appears.
 */
export function setUserBindings(bindings: Record<string, string | null>): void {
  userBindings = { ...bindings };
  scheduleInstall();
}

/** The current user keymap, as a copy. */
export function getUserBindings(): Record<string, string | null> {
  return { ...userBindings };
}

/** Drops every user binding, restoring what the apps declared. */
export function reset(): void {
  if (Object.keys(userBindings).length === 0) {
    return;
  }
  userBindings = {};
  scheduleInstall();
}

/**
 * What pressing `keys` would do right now.
 *
 * This is pure: it answers from the registry, not from the focused element, so
 * it says which shortcut *owns* the keys — not whether a text input would take
 * them. Native answers the focused question, and this is what a menu uses to
 * decide which accelerator to draw.
 */
export function resolve(keys: string): ShortcutResolution | null {
  const wanted = normaliseKeys(keys);
  // Later declarations win, matching a keymap's "last binding added" rule.
  const candidates = list().filter(shortcut => shortcut.enabled);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const shortcut = candidates[index];
    if (normaliseKeys(shortcut.keys) === wanted) {
      return { id: shortcut.id, keys: shortcut.keys, scope: shortcut.scope };
    }
  }
  return null;
}

/**
 * The id a `useShortcut` registers under.
 *
 * A scope is part of it so the same keys in two scopes are two shortcuts, which
 * is what lets an inner scope override an outer one rather than collide with it.
 */
export function shortcutId(keys: string, scope: string | undefined): string {
  const normalised = keys.trim().replace(/\s+/gu, ' ');
  return scope == null || scope === ''
    ? `shortcut:${normalised}`
    : `shortcut:${scope}/${normalised}`;
}

/** The keys bound to `id`, or `null` when it is not installed. */
export function keysFor(id: string): string | null {
  const found = list().find(shortcut => shortcut.id === id);
  return found?.keys ?? null;
}

/**
 * Lower-cases the modifier names and the key so two spellings of one shortcut
 * compare equal: `Mod+S` and `mod+s` are the same binding.
 *
 * Only used for comparison here; native does the real normalisation, where the
 * platform decides what `mod` means.
 */
export function normaliseKeys(keys: string): string {
  return (
    keys
      .trim()
      // `mod + s` and `mod+s` are one binding; whitespace around a `+` is only
      // there for readability.
      .replace(/\s*\+\s*/gu, '+')
      .split(/\s+/u)
      .map(keystroke =>
        keystroke
          .split('+')
          .map(part => part.trim().toLowerCase())
          .join('+'),
      )
      .join(' ')
  );
}

/**
 * Pushes the registry to native, coalesced into one call per tick.
 *
 * A render can register several shortcuts, and each install rebuilds the whole
 * keymap, so the push is deferred and deduplicated: an unchanged list never
 * reaches native at all.
 */
function scheduleInstall(): void {
  if (installScheduled) {
    return;
  }
  installScheduled = true;
  // A microtask, not `queueMicrotask`: the tsconfig has no DOM lib, and this is
  // the same tick without needing `globalThis` typed for it.
  Promise.resolve()
    .then(() => {
      installScheduled = false;
      return install();
    })
    .catch(() => {
      // `install` rethrows so a caller can see a rejected list; here there is
      // no caller, and an unhandled rejection would reach LogBox.
    });
}

/** The signature native is asked to match, so an unchanged list costs nothing. */
function signatureOf(shortcuts: InstalledShortcut[]): string {
  return shortcuts
    .map(
      shortcut =>
        `${shortcut.id}|${shortcut.keys}|${shortcut.scope ?? ''}|${shortcut.enabled}|${shortcut.allowInTextInput}`,
    )
    .sort()
    .join('\n');
}

/** Installs the list now, bypassing the coalescing. Awaitable for tests. */
export async function install(): Promise<void> {
  const shortcuts = list();
  const signature = signatureOf(shortcuts);
  if (signature === installedSignature) {
    return;
  }
  installedSignature = signature;
  if (NativeGpuiShortcuts == null) {
    // A platform without the desktop shell: the registry still works, so
    // `fire` and `resolve` behave, but nothing is bound.
    return;
  }
  try {
    await NativeGpuiShortcuts.shortcutInstall(shortcuts);
  } catch (error) {
    // Roll the signature back so the next change retries, rather than leaving
    // the registry believing native has a list it rejected.
    if (installedSignature === signature) {
      installedSignature = '';
    }
    throw error;
  }
}

/**
 * Subscribes to the device event native uses for a shortcut with no scope
 * element, and forwards it to the handlers.
 *
 * Called once, lazily: the desktop entry loads this module while `react-native`
 * is still initialising, so `DeviceEventEmitter` is resolved on first use rather
 * than at import time.
 */
export function installBridge(): void {
  if (nativeBridgeInstalled) {
    return;
  }
  nativeBridgeInstalled = true;
  const { DeviceEventEmitter } = require('react-native');
  DeviceEventEmitter.addListener(
    'gpuiDesktop:shortcut',
    (event: { id?: string }) => {
      if (typeof event?.id === 'string') {
        fire(event.id);
      }
    },
  );
}

/** Clears every registry structure. Test-only. */
export function __resetForTests(): void {
  definitions.clear();
  handlers.clear();
  owners.clear();
  userBindings = {};
  installedSignature = '';
  installScheduled = false;
  nativeBridgeInstalled = false;
}

/**
 * `Shortcut` — the non-hook API.
 *
 * For a module that has to register a shortcut outside a component, or attach
 * several handlers to one shortcut. A component should prefer `useShortcut`,
 * which unregisters itself when it unmounts; this is for the cases where there
 * is no component to unmount.
 *
 * ```ts
 * const off = Shortcut.addHandler('file.save', save);
 * Shortcut.register({ id: 'file.save', keys: 'mod+s', description: 'Save' });
 * ```
 */
export const Shortcut = {
  /** Attaches a handler. Returns a function that removes it. */
  addHandler(id: string, handler: ShortcutHandler): () => void {
    return addHandler(id, handler);
  },
  /** Registers one shortcut, without a component to own it. */
  register(shortcut: ShortcutDefinition): void {
    register([shortcut]);
  },
  unregister,
  /** The keys bound to `id` after any user remap. */
  keysFor,
  /** Whether `id` is installed. */
  has: (id: string): boolean => list().some(shortcut => shortcut.id === id),
};

/** The registry, for the public `Shortcuts` object. */
export const Shortcuts = {
  register,
  unregister,
  clear,
  list,
  describe,
  count,
  addHandler,
  fire,
  setUserBindings,
  getUserBindings,
  reset,
  resolve,
  keysFor,
  shortcutId,
  has: (id: string): boolean => list().some(shortcut => shortcut.id === id),
  install,
  normaliseKeys,
};

export { NO_SHORTCUTS };
