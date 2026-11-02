/**
 * Unit tests for the shortcut registry.
 *
 * The repo's vitest include list only picks up `*.test.js` under `packages/core`,
 * so this file lives at the package root rather than next to the source. The
 * preset resolves the TypeScript sources (and the `.desktop` extension order)
 * without a build step, the same way `contextMenu.test.js` imports its modules.
 *
 * The precedence itself is native — GPUI's keymap resolves it — so these tests
 * cover what JS owns: which shortcuts exist, which handlers run, what a user
 * keymap does, and how a scope is named. The two Rust tests that prove the
 * ordering are `desktop::keymap::tests::an_inner_scope_outranks_an_outer_one`
 * and `a_text_input_disables_a_shortcut_that_opts_out`.
 *
 * @format
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

// The registry installs through the TurboModule, which a unit test has no
// runtime for. A stub that records calls is enough: `install` is the only thing
// that would cross the boundary.
vi.mock('./src-gpui/src/private/specs/NativeGpuiShortcuts', () => {
  const installs = [];
  return {
    default: {
      shortcutInstall: async shortcuts => {
        installs.push(shortcuts);
        return { installed: shortcuts.length };
      },
      shortcutGet: async () => installs[installs.length - 1] ?? [],
    },
    __installs: installs,
  };
});

import {
  __resetForTests,
  addHandler,
  clear,
  count,
  describe as describeShortcuts,
  fire,
  getUserBindings,
  install,
  keysFor,
  list,
  normaliseKeys,
  register,
  reset,
  resolve,
  setUserBindings,
  shortcutId,
  unregister,
} from './src-gpui/src/private/desktop/shortcuts';

beforeEach(() => {
  __resetForTests();
});

describe('registration', () => {
  test('a shortcut is listed with its defaults filled in', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    expect(count()).toBe(1);
    expect(list()).toEqual([
      {
        id: 'file.save',
        keys: 'mod+s',
        scope: undefined,
        enabled: true,
        allowInTextInput: false,
      },
    ]);
  });

  test('an id keeps one shortcut however many components register it', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    register([{ id: 'file.save', keys: 'mod+s' }]);
    expect(count()).toBe(1);
  });

  test('re-registering replaces the keys rather than adding a second binding', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    register([{ id: 'file.save', keys: 'mod+shift+s' }]);
    expect(count()).toBe(1);
    expect(keysFor('file.save')).toBe('mod+shift+s');
  });

  test('two shortcuts with the same keys in different scopes coexist', () => {
    // This is what makes an override possible: they are two bindings, and a
    // deeper context wins.
    register([
      { id: 'save.outside', keys: 'mod+s', when: 'files' },
      { id: 'save.inside', keys: 'mod+s', when: 'editor' },
    ]);
    expect(count()).toBe(2);
    expect(list().map(shortcut => shortcut.scope)).toEqual(['files', 'editor']);
  });

  test('a shortcut with no keys is rejected', () => {
    expect(() => register([{ id: 'broken', keys: '  ' }])).toThrow(/no keys/u);
  });

  test('a shortcut with no id is rejected', () => {
    expect(() => register([{ id: '', keys: 'mod+s' }])).toThrow(
      /requires an id/u,
    );
  });

  test('unregister removes the shortcut but leaves handlers to their owner', () => {
    // A handler is owned by the function `addHandler` returned, not by the
    // definition. Removing the definition must not silently drop a handler that
    // is still mounted: a component that re-registers would otherwise install a
    // shortcut with nothing listening to it.
    const handler = vi.fn();
    const remove = addHandler('file.save', handler);
    register([{ id: 'file.save', keys: 'mod+s' }]);
    unregister('file.save');
    expect(count()).toBe(0);
    // The handler is still there, so it still runs when something fires the id.
    fire('file.save');
    expect(handler).toHaveBeenCalledOnce();
    remove();
    fire('file.save');
    expect(handler).toHaveBeenCalledOnce();
  });

  test('a re-register does not clobber a handler from a sibling effect', () => {
    // This is the bug the toggle test in the e2e caught: `useShortcut` has one
    // effect for the handler and another for the definition, so a definition
    // change (toggling `allowInTextInput`) must leave the handler alone.
    const handler = vi.fn();
    register([{ id: 'file.save', keys: 'mod+s', allowInTextInput: false }]);
    addHandler('file.save', handler);
    unregister('file.save');
    register([{ id: 'file.save', keys: 'mod+s', allowInTextInput: true }]);
    fire('file.save');
    expect(handler).toHaveBeenCalledOnce();
  });

  test('an id is only removed when its last owner lets go', () => {
    // Two components can register the same id; one unmounting must not take the
    // shortcut away from the other.
    register([{ id: 'file.save', keys: 'mod+s' }]);
    register([{ id: 'file.save', keys: 'mod+s' }]);
    unregister('file.save');
    expect(count()).toBe(1);
    unregister('file.save');
    expect(count()).toBe(0);
  });

  test('clear removes everything', () => {
    register([
      { id: 'a', keys: 'mod+a' },
      { id: 'b', keys: 'mod+b' },
    ]);
    clear();
    expect(count()).toBe(0);
    expect(list()).toEqual([]);
  });

  test('describe reports the declared fields with the effective keys', () => {
    register([
      {
        id: 'file.save',
        keys: 'mod+s',
        when: 'editor',
        description: 'Save the file',
        allowInTextInput: true,
      },
    ]);
    expect(describeShortcuts()).toEqual([
      {
        id: 'file.save',
        keys: 'mod+s',
        when: 'editor',
        enabled: true,
        allowInTextInput: true,
        description: 'Save the file',
      },
    ]);
  });
});

describe('handlers', () => {
  test('every handler for an id runs, in the order they were added', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    const order = [];
    addHandler('file.save', () => order.push('first'));
    addHandler('file.save', () => order.push('second'));
    fire('file.save');
    expect(order).toEqual(['first', 'second']);
  });

  test('a handler receives the shortcut, its keys and its scope', () => {
    register([{ id: 'file.save', keys: 'mod+s', when: 'editor' }]);
    const handler = vi.fn();
    addHandler('file.save', handler);
    fire('file.save');
    expect(handler).toHaveBeenCalledWith({
      id: 'file.save',
      keys: 'mod+s',
      scope: 'editor',
    });
  });

  test('the handler sees a remapped key, not the declared one', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    setUserBindings({ 'file.save': 'mod+shift+s' });
    const handler = vi.fn();
    addHandler('file.save', handler);
    fire('file.save');
    expect(handler.mock.calls[0][0].keys).toBe('mod+shift+s');
  });

  test('the returned function removes only that handler', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    const first = vi.fn();
    const second = vi.fn();
    const remove = addHandler('file.save', first);
    addHandler('file.save', second);
    remove();
    fire('file.save');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  test('a handler that removes itself does not disturb the loop', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    const second = vi.fn();
    const remove = addHandler('file.save', () => remove());
    addHandler('file.save', second);
    fire('file.save');
    expect(second).toHaveBeenCalledOnce();
  });

  test('firing an unregistered shortcut does nothing', () => {
    expect(() => fire('nobody.listens')).not.toThrow();
  });
});

describe('user bindings', () => {
  test('a binding replaces the declared keys', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    setUserBindings({ 'file.save': 'mod+shift+s' });
    expect(keysFor('file.save')).toBe('mod+shift+s');
    expect(getUserBindings()).toEqual({ 'file.save': 'mod+shift+s' });
  });

  test('a null binding unbinds the shortcut', () => {
    register([
      { id: 'file.save', keys: 'mod+s' },
      { id: 'file.open', keys: 'mod+o' },
    ]);
    setUserBindings({ 'file.save': null });
    // Left out of the installed list entirely: an absent binding cannot shadow
    // another one.
    expect(list().map(shortcut => shortcut.id)).toEqual(['file.open']);
  });

  test('reset restores what the app declared', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    setUserBindings({ 'file.save': 'f5' });
    reset();
    expect(keysFor('file.save')).toBe('mod+s');
    expect(getUserBindings()).toEqual({});
  });

  test('a binding for an id that is not installed is kept', () => {
    // The user bound something this screen does not have; it applies if the
    // screen appears.
    setUserBindings({ 'file.save': 'mod+shift+s' });
    expect(getUserBindings()).toEqual({ 'file.save': 'mod+shift+s' });
    register([{ id: 'file.save', keys: 'mod+s' }]);
    expect(keysFor('file.save')).toBe('mod+shift+s');
  });

  test('the keymap is a copy, so a caller cannot mutate the registry', () => {
    setUserBindings({ 'file.save': 'mod+shift+s' });
    const bindings = getUserBindings();
    bindings['file.save'] = 'f1';
    expect(getUserBindings()['file.save']).toBe('mod+shift+s');
  });
});

describe('resolution', () => {
  test('the keys resolve to the shortcut that owns them', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    expect(resolve('mod+s')).toEqual({
      id: 'file.save',
      keys: 'mod+s',
      scope: undefined,
    });
  });

  test('two spellings of one binding resolve the same way', () => {
    register([{ id: 'file.save', keys: 'Mod+S' }]);
    expect(resolve('mod+s')?.id).toBe('file.save');
    expect(normaliseKeys('Mod + S')).toBe('mod+s');
  });

  test('the last declaration wins, as a later keymap binding does', () => {
    register([
      { id: 'first', keys: 'mod+s' },
      { id: 'second', keys: 'mod+s' },
    ]);
    expect(resolve('mod+s')?.id).toBe('second');
  });

  test('a disabled shortcut does not resolve', () => {
    register([{ id: 'file.save', keys: 'mod+s', enabled: false }]);
    expect(resolve('mod+s')).toBeNull();
  });

  test('an unbound key resolves to nothing', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    expect(resolve('mod+q')).toBeNull();
  });

  test('a remap changes what resolves', () => {
    register([{ id: 'file.save', keys: 'mod+s' }]);
    setUserBindings({ 'file.save': 'mod+shift+s' });
    expect(resolve('mod+s')).toBeNull();
    expect(resolve('mod+shift+s')?.id).toBe('file.save');
  });

  test('a chord is one binding, not two', () => {
    register([{ id: 'chord.save', keys: 'mod+k mod+s' }]);
    expect(resolve('mod+k mod+s')?.id).toBe('chord.save');
    expect(resolve('mod+k')).toBeNull();
  });
});

describe('installing', () => {
  test('the same list installs once', async () => {
    const { __installs } =
      await import('./src-gpui/src/private/specs/NativeGpuiShortcuts');
    __installs.length = 0;

    register([{ id: 'file.save', keys: 'mod+s' }]);
    await install();
    await install();
    // The signature is unchanged, so the second call never reaches native.
    expect(__installs.length).toBe(1);
    expect(__installs[0]).toHaveLength(1);

    register([{ id: 'file.save', keys: 'mod+shift+s' }]);
    await install();
    expect(__installs.length).toBe(2);
  });

  test('a null binding is not installed', async () => {
    const { __installs } =
      await import('./src-gpui/src/private/specs/NativeGpuiShortcuts');
    __installs.length = 0;
    register([{ id: 'file.save', keys: 'mod+s' }]);
    await install();
    setUserBindings({ 'file.save': null });
    await install();
    expect(__installs[__installs.length - 1]).toEqual([]);
  });
});

describe('scope names', () => {
  test('a hook id includes its scope, so two scopes do not collide', () => {
    expect(shortcutId('mod+s', 'editor')).toBe('shortcut:editor/mod+s');
    expect(shortcutId('mod+s', 'files')).toBe('shortcut:files/mod+s');
    expect(shortcutId('mod+s', undefined)).toBe('shortcut:mod+s');
  });

  test('whitespace in the keys does not change the id', () => {
    expect(shortcutId('mod+k   mod+s', 'editor')).toBe(
      'shortcut:editor/mod+k mod+s',
    );
  });
});
