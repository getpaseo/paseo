/**
 * Unit tests for the custom context menu's pure modules.
 *
 * The repo's vitest include list only picks up `*.test.js` under `packages/core`,
 * so this file lives at the package root rather than next to the sources. The
 * sources it imports are TypeScript, and the GPUI vitest preset resolves those
 * with the `.desktop`/`.native` extension order and the same `react-native`
 * alias the rest of `packages/core`'s tests use, so importing the modules
 * directly works without a build step.
 *
 * @format
 */

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MENU_MARGIN,
  measurableSize,
  placeRootMenu,
  placeSubmenu,
} from './src-gpui/src/private/desktop/contextMenu/placement';
import {
  placeLevels,
  rowRect as rowRectOf,
} from './src-gpui/src/private/desktop/contextMenu/levels';
import {
  EMPTY_NAVIGATION,
  TYPEAHEAD_TIMEOUT_MS,
  firstEnabledIndex,
  lastEnabledIndex,
  navigate,
  nextEnabledIndex,
  typeaheadIndex,
} from './src-gpui/src/private/desktop/contextMenu/navigation';
import {
  dark,
  light,
  mergeTheme,
  themeForScheme,
} from './src-gpui/src/private/desktop/contextMenu/theme';
import { formatAccelerator } from './src-gpui/src/private/desktop/contextMenu/accelerator';
import {
  isInSafeTriangle,
  safeTriangleFor,
} from './src-gpui/src/private/desktop/contextMenu/safeTriangle';
import {
  contextMenuConfig,
  setContextMenuConfig,
  setContextMenuRenderers,
  contextMenuRenderers,
  contextMenuTheme,
  setContextMenuPresentation,
  contextMenuPresentation,
  setContextMenuTheme,
  subscribeContextMenuConfig,
} from './src-gpui/src/private/desktop/contextMenu/config';
import {
  contextMenuHostFor,
  contextMenuWindowIds,
  hasContextMenuHost,
  registerContextMenuHost,
  unregisterContextMenuHost,
} from './src-gpui/src/private/desktop/contextMenu/registry';
import {
  entryId,
  entryLabel,
  entryTestId,
  isChecked,
  isEnabled,
  isSubmenu,
  humanizeRole,
} from './src-gpui/src/private/desktop/contextMenu/types';

const windowSize = { width: 1000, height: 800 };

describe('placeRootMenu', () => {
  test('places the menu at the anchor when it fits', () => {
    expect(
      placeRootMenu({
        anchor: { x: 100, y: 120 },
        menuSize: { width: 200, height: 150 },
        windowSize,
      }),
    ).toEqual({ x: 100, y: 120 });
  });

  test('flips left at the right edge and stays inside', () => {
    // 900 + 200 > 996 (the window width less the margin), so it opens leftwards.
    const point = placeRootMenu({
      anchor: { x: 900, y: 100 },
      menuSize: { width: 200, height: 150 },
      windowSize,
    });
    expect(point.x).toBe(700);
    expect(point.x + 200).toBeLessThanOrEqual(windowSize.width);
  });

  test('flips up at the bottom edge and stays inside', () => {
    const point = placeRootMenu({
      anchor: { x: 100, y: 700 },
      menuSize: { width: 200, height: 150 },
      windowSize,
    });
    expect(point.y).toBe(550);
    expect(point.y + 150).toBeLessThanOrEqual(windowSize.height);
  });

  test('flips in both directions in the bottom-right corner', () => {
    expect(
      placeRootMenu({
        anchor: { x: 980, y: 780 },
        menuSize: { width: 200, height: 150 },
        windowSize,
      }),
    ).toEqual({ x: 780, y: 630 });
  });

  test('clamps to the margin when the anchor is outside the window', () => {
    expect(
      placeRootMenu({
        anchor: { x: -50, y: -80 },
        menuSize: { width: 200, height: 150 },
        windowSize,
      }),
    ).toEqual({ x: DEFAULT_MENU_MARGIN, y: DEFAULT_MENU_MARGIN });
  });

  test('clamps past the far edge rather than overflowing', () => {
    const point = placeRootMenu({
      anchor: { x: 5000, y: 5000 },
      menuSize: { width: 200, height: 150 },
      windowSize,
    });
    expect(point).toEqual({
      x: windowSize.width - DEFAULT_MENU_MARGIN - 200,
      y: windowSize.height - DEFAULT_MENU_MARGIN - 150,
    });
  });

  test('keeps a menu bigger than the window against the near margin', () => {
    const point = placeRootMenu({
      anchor: { x: 400, y: 400 },
      menuSize: { width: 1400, height: 1200 },
      windowSize,
    });
    expect(point).toEqual({ x: DEFAULT_MENU_MARGIN, y: DEFAULT_MENU_MARGIN });
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
  });

  test('honours a wider margin', () => {
    expect(
      placeRootMenu({
        anchor: { x: 0, y: 0 },
        menuSize: { width: 100, height: 100 },
        windowSize,
        margin: 20,
      }),
    ).toEqual({ x: 20, y: 20 });
  });

  test('treats a negative margin as no margin and a non-finite one as the default', () => {
    expect(
      placeRootMenu({
        anchor: { x: 0, y: 0 },
        menuSize: { width: 100, height: 100 },
        windowSize,
        margin: -10,
      }),
    ).toEqual({ x: 0, y: 0 });
    for (const margin of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        placeRootMenu({
          anchor: { x: 0, y: 0 },
          menuSize: { width: 100, height: 100 },
          windowSize,
          margin,
        }),
      ).toEqual({ x: DEFAULT_MENU_MARGIN, y: DEFAULT_MENU_MARGIN });
    }
  });

  test('is deterministic', () => {
    const input = {
      anchor: { x: 950, y: 780 },
      menuSize: { width: 240, height: 180 },
      windowSize,
    };
    expect(placeRootMenu(input)).toEqual(placeRootMenu(input));
  });
});

describe('placeSubmenu', () => {
  const rowRect = { x: 200, y: 300, width: 180, height: 26 };

  test('opens to the right of the row when there is room', () => {
    const placed = placeSubmenu({
      rowRect,
      menuSize: { width: 200, height: 100 },
      windowSize,
    });
    expect(placed).toEqual({ x: 380, y: 300, side: 'right' });
  });

  test('opens to the left when the right edge is too close', () => {
    const placed = placeSubmenu({
      rowRect: { x: 800, y: 300, width: 180, height: 26 },
      menuSize: { width: 200, height: 100 },
      windowSize,
    });
    expect(placed.side).toBe('left');
    expect(placed.x).toBe(600);
  });

  test('aligns vertically with the row and clamps near the bottom', () => {
    const placed = placeSubmenu({
      rowRect: { x: 200, y: 760, width: 180, height: 26 },
      menuSize: { width: 200, height: 100 },
      windowSize,
    });
    expect(placed.y).toBe(windowSize.height - DEFAULT_MENU_MARGIN - 100);
    expect(placed.y + 100).toBeLessThanOrEqual(windowSize.height);
  });

  test('clamps a submenu wider than the window to the near margin', () => {
    const placed = placeSubmenu({
      rowRect,
      menuSize: { width: 1200, height: 100 },
      windowSize,
    });
    expect(placed.x).toBe(DEFAULT_MENU_MARGIN);
    expect(placed.side).toBe('left');
  });

  test('still reports a side when clamped on both axes', () => {
    const placed = placeSubmenu({
      rowRect: { x: 990, y: 790, width: 10, height: 10 },
      menuSize: { width: 900, height: 900 },
      windowSize,
    });
    expect(placed.side).toBe('left');
    expect(placed.x).toBeGreaterThanOrEqual(0);
    expect(placed.y).toBeGreaterThanOrEqual(0);
  });
});

describe('measurableSize', () => {
  test('accepts a measured window', () => {
    expect(measurableSize({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  test('rejects a zero or non-finite layout', () => {
    expect(measurableSize({ width: 0, height: 600 })).toBeNull();
    expect(measurableSize({ width: 800, height: 0 })).toBeNull();
    expect(measurableSize({ width: Number.NaN, height: 600 })).toBeNull();
  });
});

const items = [
  { id: 'new', label: 'New' },
  { type: 'separator' },
  { id: 'open', label: 'Open' },
  { id: 'save', label: 'Save', enabled: false },
  { type: 'submenu', id: 'export', label: 'Export', items: [] },
  { id: 'edit', label: 'Edit' },
];

describe('nextEnabledIndex', () => {
  test('skips separators and disabled rows', () => {
    expect(nextEnabledIndex(items, -1, 1)).toBe(0);
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
    expect(nextEnabledIndex(items, 2, 1)).toBe(4);
  });

  test('wraps at both ends', () => {
    expect(nextEnabledIndex(items, 5, 1)).toBe(0);
    expect(nextEnabledIndex(items, 0, -1)).toBe(5);
    expect(nextEnabledIndex(items, -1, -1)).toBe(5);
  });

  test('returns -1 for a level with nothing selectable', () => {
    expect(
      nextEnabledIndex([{ type: 'separator' }, { type: 'separator' }], -1, 1),
    ).toBe(-1);
  });

  test('first and last go to a selectable row', () => {
    expect(firstEnabledIndex(items)).toBe(0);
    expect(lastEnabledIndex(items)).toBe(5);
  });
});

describe('typeaheadIndex', () => {
  test('finds a row by its label prefix', () => {
    expect(typeaheadIndex(items, 'op', -1, false)).toBe(2);
    expect(typeaheadIndex(items, 'ex', -1, false)).toBe(4);
  });

  test('is case insensitive', () => {
    expect(typeaheadIndex(items, 'NEW', -1, false)).toBe(0);
  });

  test('skips a disabled match', () => {
    // "Save" is disabled and is the only S row, so nothing matches.
    expect(typeaheadIndex(items, 's', -1, false)).toBe(-1);
  });

  test('keeps the current row while the buffer grows', () => {
    expect(typeaheadIndex(items, 'ed', 5, true)).toBe(5);
  });

  test('cycles to the next match when the buffer restarts', () => {
    const rows = [
      { id: 'a', label: 'Edit' },
      { id: 'b', label: 'Export' },
      { id: 'c', label: 'Extend' },
    ];
    expect(typeaheadIndex(rows, 'e', -1, false)).toBe(0);
    expect(typeaheadIndex(rows, 'e', 0, false)).toBe(1);
    expect(typeaheadIndex(rows, 'e', 1, false)).toBe(2);
    expect(typeaheadIndex(rows, 'e', 2, false)).toBe(0);
  });

  test('returns the current index when nothing matches', () => {
    expect(typeaheadIndex(items, 'zz', 2, false)).toBe(2);
  });
});

describe('navigate', () => {
  const state = index => ({ index, typed: '', typedAt: 0 });

  test('Down moves to the next selectable row and wraps', () => {
    expect(navigate({ items, key: 'down', state: state(-1) })).toEqual({
      state: state(0),
      action: 'none',
    });
    expect(navigate({ items, key: 'down', state: state(5) }).state.index).toBe(
      0,
    );
  });

  test('Up moves backwards and wraps', () => {
    expect(navigate({ items, key: 'up', state: state(0) }).state.index).toBe(5);
    expect(navigate({ items, key: 'up', state: state(-1) }).state.index).toBe(
      5,
    );
  });

  test('Home and End go to the first and last selectable rows', () => {
    expect(navigate({ items, key: 'home', state: state(4) }).state.index).toBe(
      0,
    );
    expect(navigate({ items, key: 'end', state: state(0) }).state.index).toBe(
      5,
    );
  });

  test('Right opens a submenu only on a submenu row', () => {
    expect(navigate({ items, key: 'right', state: state(4) }).action).toBe(
      'openSubmenu',
    );
    expect(navigate({ items, key: 'right', state: state(2) }).action).toBe(
      'none',
    );
    expect(navigate({ items, key: 'right', state: state(-1) }).action).toBe(
      'none',
    );
  });

  test('Left and Escape close a level', () => {
    expect(navigate({ items, key: 'left', state: state(2) }).action).toBe(
      'closeLevel',
    );
    expect(navigate({ items, key: 'escape', state: state(2) }).action).toBe(
      'closeLevel',
    );
    expect(navigate({ items, key: 'Esc', state: state(2) }).action).toBe(
      'closeLevel',
    );
  });

  test('Enter activates a row and opens a submenu', () => {
    expect(navigate({ items, key: 'enter', state: state(2) }).action).toBe(
      'activate',
    );
    expect(navigate({ items, key: 'enter', state: state(4) }).action).toBe(
      'openSubmenu',
    );
    expect(navigate({ items, key: 'enter', state: state(-1) }).action).toBe(
      'none',
    );
    expect(navigate({ items, key: 'enter', state: state(3) }).action).toBe(
      'none',
    );
  });

  test('Space activates like Enter', () => {
    expect(navigate({ items, key: ' ', state: state(2) }).action).toBe(
      'activate',
    );
  });

  test('type-to-select moves the highlight and accumulates', () => {
    const first = navigate({
      items,
      key: 'o',
      state: state(-1),
      now: 1000,
    });
    expect(first.state.index).toBe(2);
    expect(first.state.typed).toBe('o');
    const second = navigate({
      items,
      key: 'p',
      state: first.state,
      now: 1100,
    });
    expect(second.state.typed).toBe('op');
    expect(second.state.index).toBe(2);
  });

  test('the buffer expires after the timeout', () => {
    const first = navigate({ items, key: 'e', state: state(-1), now: 1000 });
    expect(first.state.typed).toBe('e');
    const later = navigate({
      items,
      key: 'n',
      state: first.state,
      now: 1000 + TYPEAHEAD_TIMEOUT_MS + 1,
    });
    // The old buffer is gone, so the new key starts one of its own.
    expect(later.state.typed).toBe('n');
    expect(later.state.index).toBe(0);
  });

  test('a modifier turns a character into a shortcut, not type-ahead', () => {
    const result = navigate({
      items,
      key: 'k',
      state: EMPTY_NAVIGATION,
      now: 1000,
      modifiers: { meta: true },
    });
    expect(result.state).toEqual(EMPTY_NAVIGATION);
    expect(result.action).toBe('none');
  });

  test('unknown keys leave the state alone', () => {
    const before = state(2);
    expect(navigate({ items, key: 'f13', state: before })).toEqual({
      state: before,
      action: 'none',
    });
  });
});

describe('theme', () => {
  test('the built-in themes have every token', () => {
    for (const theme of [light, dark]) {
      for (const token of [
        'background',
        'foreground',
        'mutedForeground',
        'separator',
        'border',
        'highlightBackground',
        'highlightForeground',
        'disabledForeground',
        'shadow',
        'fontSize',
        'rowHeight',
        'paddingX',
        'paddingY',
        'radius',
        'minWidth',
        'maxWidth',
      ]) {
        expect(theme[token]).toBeDefined();
      }
      expect(theme.minWidth).toBeLessThan(theme.maxWidth);
    }
    expect(light.background).not.toBe(dark.background);
  });

  test('merging applies the override', () => {
    const merged = mergeTheme(light, {
      background: '#000000',
      fontSize: 16,
    });
    expect(merged.background).toBe('#000000');
    expect(merged.fontSize).toBe(16);
    expect(merged.foreground).toBe(light.foreground);
  });

  test('an undefined field does not erase the base value', () => {
    const merged = mergeTheme(light, {
      background: undefined,
      fontFamily: undefined,
    });
    expect(merged.background).toBe(light.background);
    expect(merged.fontFamily).toBe(light.fontFamily);
  });

  test('merging does not mutate the base theme', () => {
    const before = { ...light };
    mergeTheme(light, { fontSize: 20 });
    expect(light).toEqual(before);
  });

  test('a missing override returns a copy', () => {
    const copy = mergeTheme(light);
    expect(copy).toEqual(light);
    expect(copy).not.toBe(light);
  });

  test('a scheme picks the matching built-in theme', () => {
    expect(themeForScheme('dark').background).toBe(dark.background);
    expect(themeForScheme('light').background).toBe(light.background);
    // An unknown scheme (RN reports null before the platform answers) uses light.
    expect(themeForScheme(null).background).toBe(light.background);
    expect(themeForScheme(undefined).background).toBe(light.background);
  });

  test('overrides only apply to their own scheme', () => {
    const overrides = { dark: { background: '#101010' } };
    expect(themeForScheme('dark', overrides).background).toBe('#101010');
    expect(themeForScheme('light', overrides).background).toBe(
      light.background,
    );
  });
});

describe('formatAccelerator', () => {
  test('spells a shortcut with the macOS symbols', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+K', 'macos')).toBe(
      '\u2318\u21e7K',
    );
  });

  test('spells the same shortcut in words elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+K', 'windows')).toBe(
      'Ctrl+Shift+K',
    );
    expect(formatAccelerator('CmdOrCtrl+Shift+K', 'linux')).toBe(
      'Ctrl+Shift+K',
    );
  });

  test('keeps a single character key as written', () => {
    expect(formatAccelerator('Cmd+Z', 'macos')).toBe('\u2318Z');
    expect(formatAccelerator('Ctrl+z', 'linux')).toBe('Ctrl+z');
  });

  test('names special keys', () => {
    expect(formatAccelerator('Cmd+Enter', 'macos')).toBe('\u2318\u21a9');
    expect(formatAccelerator('Ctrl+Enter', 'windows')).toBe('Ctrl+Enter');
  });

  test('returns an empty string for a missing or empty spec', () => {
    expect(formatAccelerator(undefined, 'macos')).toBe('');
    expect(formatAccelerator('   ', 'macos')).toBe('');
  });
});

describe('safe triangle', () => {
  const submenuRect = { x: 400, y: 200, width: 200, height: 160 };

  test('a right-opening submenu uses its left edge', () => {
    const triangle = safeTriangleFor({ x: 200, y: 260 }, submenuRect, 'right');
    expect(triangle.nearTop).toEqual({ x: 400, y: 200 });
    expect(triangle.nearBottom).toEqual({ x: 400, y: 360 });
  });

  test('a left-opening submenu uses its right edge', () => {
    const triangle = safeTriangleFor({ x: 800, y: 260 }, submenuRect, 'left');
    expect(triangle.nearTop).toEqual({ x: 600, y: 200 });
    expect(triangle.nearBottom).toEqual({ x: 600, y: 360 });
  });

  test('a diagonal move towards the submenu stays inside', () => {
    const triangle = safeTriangleFor({ x: 200, y: 210 }, submenuRect, 'right');
    expect(isInSafeTriangle({ x: 300, y: 240 }, triangle)).toBe(true);
  });

  test('a move far above the triangle is outside', () => {
    const triangle = safeTriangleFor({ x: 200, y: 260 }, submenuRect, 'right');
    expect(isInSafeTriangle({ x: 380, y: 100 }, triangle)).toBe(false);
  });

  test('a move below the origin is outside', () => {
    const triangle = safeTriangleFor({ x: 200, y: 260 }, submenuRect, 'right');
    expect(isInSafeTriangle({ x: 300, y: 500 }, triangle)).toBe(false);
  });

  test('the near edge counts as inside', () => {
    const triangle = safeTriangleFor({ x: 200, y: 260 }, submenuRect, 'right');
    expect(isInSafeTriangle({ x: 400, y: 280 }, triangle)).toBe(true);
    expect(isInSafeTriangle({ x: 400, y: 200 }, triangle)).toBe(true);
    expect(isInSafeTriangle({ x: 400, y: 360 }, triangle)).toBe(true);
  });
});

describe('entry helpers', () => {
  test('a separator is never enabled', () => {
    expect(isEnabled({ type: 'separator' })).toBe(false);
    expect(isEnabled({ id: 'a', label: 'A' })).toBe(true);
    expect(isEnabled({ id: 'a', label: 'A', enabled: false })).toBe(false);
  });

  test('checked only means something for a plain item', () => {
    expect(isChecked({ id: 'a', label: 'A', checked: true })).toBe(true);
    expect(isChecked({ id: 'a', label: 'A' })).toBe(false);
    expect(isChecked({ type: 'submenu', label: 'S', items: [] })).toBe(false);
  });

  test('a submenu is recognised', () => {
    expect(isSubmenu({ type: 'submenu', label: 'S', items: [] })).toBe(true);
    expect(isSubmenu({ id: 'a', label: 'A' })).toBe(false);
  });

  test('a role item resolves with its role and gets a label', () => {
    expect(entryId({ type: 'role', role: 'selectAll' })).toBe('selectAll');
    expect(entryLabel({ type: 'role', role: 'selectAll' })).toBe('Select All');
    expect(entryLabel({ type: 'role', role: 'copy', label: 'Copy text' })).toBe(
      'Copy text',
    );
    expect(humanizeRole('hideOthers')).toBe('Hide Others');
  });

  test('test ids use the id, or a slug of the label', () => {
    expect(entryTestId({ id: 'open', label: 'Open' })).toBe('open');
    expect(entryTestId({ type: 'role', role: 'selectAll' })).toBe('selectAll');
    expect(
      entryTestId({ type: 'submenu', label: 'More Options', items: [] }),
    ).toBe('more-options');
  });
});

describe('config store', () => {
  test('notifies subscribers and can be reset', () => {
    let calls = 0;
    const unsubscribe = subscribeContextMenuConfig(() => {
      calls += 1;
    });
    setContextMenuTheme({ dark: { background: '#000000' } });
    expect(calls).toBe(1);
    expect(contextMenuConfig().theme.dark.background).toBe('#000000');
    unsubscribe();
    setContextMenuConfig({});
    expect(calls).toBe(1);
    expect(contextMenuConfig().theme).toBeUndefined();
  });
});

describe('renderers store', () => {
  const Row = () => null;
  const Surface = () => null;

  test('replacing one slot keeps the others and the theme', () => {
    setContextMenuConfig({ theme: { dark: { background: '#000000' } } });
    setContextMenuRenderers({ Row });
    expect(contextMenuRenderers().Row).toBe(Row);
    // Setting renderers must not drop unrelated config: the two setters share a
    // store, and a replacement that silently reset the theme would be a mystery.
    expect(contextMenuTheme().dark.background).toBe('#000000');

    setContextMenuRenderers({ Row, Surface });
    expect(contextMenuRenderers().Row).toBe(Row);
    expect(contextMenuRenderers().Surface).toBe(Surface);

    setContextMenuRenderers(undefined);
    expect(contextMenuRenderers()).toBeUndefined();
    expect(contextMenuTheme().dark.background).toBe('#000000');
    setContextMenuConfig({});
  });

  test('an explicit undefined slot means the built-in', () => {
    setContextMenuRenderers({ Row, Surface: undefined });
    expect(contextMenuRenderers().Row).toBe(Row);
    // `undefined` is the documented way back to the built-in for one slot, so the
    // host's `?? MenuSurface` fallback has to see it rather than an empty object.
    expect(contextMenuRenderers().Surface).toBeUndefined();
    setContextMenuConfig({});
  });
});

describe('presentation resolution', () => {
  test('the app default applies only to default, never to an explicit choice', () => {
    setContextMenuPresentation('custom');
    expect(contextMenuPresentation()).toBe('custom');
    // An explicit 'native' must win over the app default, otherwise an app that
    // set a custom default could never ask for the platform's menu.
    setContextMenuPresentation('native');
    expect(contextMenuPresentation()).toBe('native');
  });

  test('unset means default, which the platform decides', () => {
    setContextMenuPresentation(undefined);
    expect(contextMenuPresentation()).toBe('default');
  });
});

describe('registry', () => {
  const handle = { open: () => Promise.resolve(null), close: () => {} };

  test('registers, looks up and unregisters by window id', () => {
    const remove = registerContextMenuHost(7, handle);
    expect(hasContextMenuHost(7)).toBe(true);
    expect(contextMenuHostFor(7)).toBe(handle);
    expect(contextMenuWindowIds()).toContain(7);
    remove();
    expect(contextMenuHostFor(7)).toBeNull();
  });

  test('a second registration for one window wins', () => {
    const first = { open: () => Promise.resolve(null), close: () => {} };
    const second = { open: () => Promise.resolve(null), close: () => {} };
    const removeFirst = registerContextMenuHost(8, first);
    registerContextMenuHost(8, second);
    expect(contextMenuHostFor(8)).toBe(second);
    // The stale unmount must not remove the replacement.
    removeFirst();
    expect(contextMenuHostFor(8)).toBe(second);
    unregisterContextMenuHost(8);
    expect(contextMenuHostFor(8)).toBeNull();
  });

  test('unregistering a specific host leaves another one alone', () => {
    const other = { open: () => Promise.resolve(null), close: () => {} };
    registerContextMenuHost(9, handle);
    unregisterContextMenuHost(9, other);
    expect(contextMenuHostFor(9)).toBe(handle);
    unregisterContextMenuHost(9, handle);
    expect(contextMenuHostFor(9)).toBeNull();
  });

  test('an unknown window has no host', () => {
    expect(contextMenuHostFor(12345)).toBeNull();
    expect(hasContextMenuHost(12345)).toBe(false);
  });
});

/**
 * A level with one 26px row per entry, starting at `y` inside the panel. The
 * rows are what the host learns from each row's `onLayout`; the size is what the
 * panel reports about itself.
 */
function level({ size, parentIndex = 0, rows, openedAt = null }) {
  return {
    items: [],
    highlightedIndex: -1,
    size,
    rows,
    parentIndex,
    openedAt,
  };
}

/** Rows laid out top to bottom with the given height, plus the panel's padding. */
function rowsOf(count, height = 26, paddingTop = 4) {
  const rows = {};
  for (let index = 0; index < count; index += 1) {
    rows[index] = { y: paddingTop + index * height, height };
  }
  return rows;
}

describe('placeLevels chaining', () => {
  const bigWindow = { width: 1000, height: 800 };

  test('a three-level chain attaches each level to its own parent row', () => {
    // Root at (100, 100), 200x150, rows 26px tall from y=4.
    // Row 1 of the root is therefore at window y = 100 + 4 + 26 = 130.
    const root = level({
      size: { width: 200, height: 150 },
      rows: rowsOf(5),
    });
    // The submenu opens beside the root's row 1 at x = 300, y = 130; its own
    // row 2 is at y = 130 + 4 + 2*26 = 190.
    const submenu = level({
      size: { width: 180, height: 120 },
      parentIndex: 1,
      rows: rowsOf(4),
    });
    // The third level must use the submenu's row 2, not the root's row 1.
    const subSubmenu = level({
      size: { width: 160, height: 90 },
      parentIndex: 2,
      rows: rowsOf(3),
    });

    const placed = placeLevels(
      [root, submenu, subSubmenu],
      { x: 100, y: 100 },
      bigWindow,
    );

    expect(placed[0]).toEqual({ point: { x: 100, y: 100 }, side: null });
    expect(placed[1]).toEqual({ point: { x: 300, y: 130 }, side: 'right' });
    // x = 300 + 180 = 480; y = 130 + (4 + 2*26) = 186, i.e. the submenu's own
    // row 2. Using the root's placement instead would give y = 130, which is the
    // chaining bug this asserts against.
    expect(placed[2]).toEqual({ point: { x: 480, y: 186 }, side: 'right' });
  });

  test('a third level follows its parent, not the root, on every axis', () => {
    // Put the root's referenced row and the submenu's referenced row at
    // different y values, then check the third level matches the submenu.
    const root = level({
      size: { width: 200, height: 40 },
      rows: rowsOf(3),
    });
    const submenu = level({
      size: { width: 200, height: 200 },
      parentIndex: 2,
      rows: rowsOf(6),
    });
    const subSubmenu = level({
      size: { width: 100, height: 100 },
      parentIndex: 5,
      rows: rowsOf(2),
    });
    const placed = placeLevels(
      [root, submenu, subSubmenu],
      { x: 50, y: 50 },
      bigWindow,
    );
    const rootRowY = 50 + 4 + 2 * 26;
    const submenuRowY = rootRowY + 4 + 5 * 26;
    expect(placed[1].point).toEqual({ x: 250, y: rootRowY });
    expect(placed[2].point).toEqual({ x: 450, y: submenuRowY });
    expect(placed[2].point.y).not.toBe(rootRowY);
  });

  test('an unmeasured parent yields null and propagates it downwards', () => {
    const root = level({ size: { width: 200, height: 150 }, rows: rowsOf(5) });
    const unmeasured = level({
      size: null,
      parentIndex: 0,
      rows: {},
    });
    const below = level({
      size: { width: 100, height: 100 },
      parentIndex: 0,
      rows: rowsOf(2),
    });
    let placed;
    expect(() => {
      placed = placeLevels(
        [root, unmeasured, below],
        { x: 10, y: 10 },
        bigWindow,
      );
    }).not.toThrow();
    expect(placed[0]).toEqual({ point: { x: 10, y: 10 }, side: null });
    expect(placed[1]).toBeNull();
    // Its parent has no position, so it cannot be placed either; it must not
    // silently fall back to the root.
    expect(placed[2]).toBeNull();
  });

  test('a level whose parent row has not been measured yet yields null', () => {
    const root = level({ size: { width: 200, height: 150 }, rows: {} });
    const child = level({
      size: { width: 100, height: 100 },
      parentIndex: 0,
      rows: rowsOf(2),
    });
    const placed = placeLevels([root, child], { x: 10, y: 10 }, bigWindow);
    expect(placed[0]).not.toBeNull();
    expect(placed[1]).toBeNull();
  });

  test('a missing anchor or window size places nothing', () => {
    const root = level({ size: { width: 200, height: 150 }, rows: rowsOf(5) });
    expect(placeLevels([root], null, bigWindow)).toEqual([null]);
    expect(placeLevels([root], { x: 1, y: 1 }, null)).toEqual([null]);
    expect(placeLevels([root], undefined, bigWindow)).toEqual([null]);
    expect(placeLevels([root], { x: 1, y: 1 }, undefined)).toEqual([null]);
  });

  test('a chain running off the bottom is clamped level by level', () => {
    const window = { width: 600, height: 300 };
    const root = level({
      size: { width: 150, height: 200 },
      rows: rowsOf(8),
    });
    const child = level({
      size: { width: 150, height: 180 },
      parentIndex: 7,
      rows: rowsOf(6),
    });
    const grandchild = level({
      size: { width: 150, height: 160 },
      parentIndex: 5,
      rows: rowsOf(5),
    });
    // Anchor near the bottom so the root itself has to flip up.
    const placed = placeLevels(
      [root, child, grandchild],
      { x: 20, y: 280 },
      window,
    );
    for (const entry of placed) {
      expect(entry).not.toBeNull();
      expect(entry.point.y).toBeGreaterThanOrEqual(0);
      expect(entry.point.x).toBeGreaterThanOrEqual(0);
      expect(entry.point.y).toBeLessThanOrEqual(window.height);
      expect(entry.point.x).toBeLessThanOrEqual(window.width);
    }
    // Each level's own size still fits inside the window.
    expect(placed[1].point.y + 180).toBeLessThanOrEqual(window.height);
    expect(placed[2].point.y + 160).toBeLessThanOrEqual(window.height);
  });

  test('a submenu on the last row flips up while the root stays put', () => {
    const window = { width: 800, height: 800 };
    // The root fits comfortably at the anchor, so it must not move.
    const root = level({
      size: { width: 200, height: 240 },
      rows: rowsOf(9),
    });
    // The child opens beside the last row, which is near the bottom, and is
    // taller than the space left below it, so it has to be clamped upwards.
    const child = level({
      size: { width: 200, height: 200 },
      parentIndex: 8,
      rows: rowsOf(7),
    });
    const placed = placeLevels([root, child], { x: 100, y: 300 }, window);
    expect(placed[0]).toEqual({ point: { x: 100, y: 300 }, side: null });
    // The last row is at 300 + 4 + 8*26 = 512; a 200px menu would end at 712,
    // which still fits in 800, so clamping only starts past the margin.
    expect(placed[1].point.y).toBe(512);
    expect(placed[1].point.y + 200).toBeLessThanOrEqual(window.height);
  });

  test('a submenu near the bottom is pulled up without moving the root', () => {
    const window = { width: 800, height: 600 };
    const root = level({
      size: { width: 200, height: 240 },
      rows: rowsOf(9),
    });
    const child = level({
      size: { width: 200, height: 200 },
      parentIndex: 8,
      rows: rowsOf(7),
    });
    // Last root row at 400 + 4 + 8*26 = 612, past the bottom, so the root flips.
    const placed = placeLevels([root, child], { x: 100, y: 400 }, window);
    expect(placed[0].point).toEqual({ x: 100, y: 400 - 240 });
    expect(placed[1].point.y + 200).toBeLessThanOrEqual(window.height);
    expect(placed[1].point.y).toBeGreaterThanOrEqual(DEFAULT_MENU_MARGIN);
  });

  test('is deterministic and leaves its input untouched', () => {
    const root = level({ size: { width: 200, height: 150 }, rows: rowsOf(5) });
    const child = level({
      size: { width: 180, height: 120 },
      parentIndex: 1,
      rows: rowsOf(4),
    });
    const levels = [root, child];
    const snapshot = JSON.parse(JSON.stringify(levels));
    const first = placeLevels(levels, { x: 100, y: 100 }, bigWindow);
    const second = placeLevels(levels, { x: 100, y: 100 }, bigWindow);
    expect(second).toEqual(first);
    expect(levels).toEqual(snapshot);
    expect(levels[0]).toBe(root);
    expect(levels[0].rows).toBe(root.rows);
  });

  test('one level places on its own like placeRootMenu', () => {
    const root = level({ size: { width: 200, height: 150 }, rows: rowsOf(5) });
    const placed = placeLevels([root], { x: 950, y: 780 }, bigWindow);
    expect(placed[0].point).toEqual(
      placeRootMenu({
        anchor: { x: 950, y: 780 },
        menuSize: { width: 200, height: 150 },
        windowSize: bigWindow,
      }),
    );
  });

  test('an empty chain is an empty array', () => {
    expect(placeLevels([], { x: 0, y: 0 }, bigWindow)).toEqual([]);
  });
});

describe('rowRect', () => {
  test('adds the panel position to a row measured relative to it', () => {
    const root = level({
      size: { width: 200, height: 150 },
      rows: rowsOf(5),
    });
    expect(rowRectOf(root, { x: 100, y: 100 }, 1)).toEqual({
      x: 100,
      y: 100 + 4 + 26,
      width: 200,
      height: 26,
    });
  });

  test('returns null without a measurement', () => {
    const root = level({ size: null, rows: rowsOf(2) });
    expect(rowRectOf(root, { x: 0, y: 0 }, 0)).toBeNull();
    const noRows = level({ size: { width: 10, height: 10 }, rows: {} });
    expect(rowRectOf(noRows, { x: 0, y: 0 }, 3)).toBeNull();
  });
});
