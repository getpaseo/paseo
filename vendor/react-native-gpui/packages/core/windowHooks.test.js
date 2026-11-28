/**
 * `useWindowState` and `useWindowFocus` against a fake module and a minimal hook
 * runner: there is no React renderer in the unit-test environment, so the two
 * hooks run inside a harness that implements `useState` and `useEffect`.
 *
 * @format
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const listeners = new Map();
const state = { value: null };

vi.mock('react-native', () => ({
  DeviceEventEmitter: {
    addListener: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return { remove: () => set.delete(listener) };
    },
  },
  TurboModuleRegistry: { getEnforcing: () => ({}), get: () => ({}) },
  AppRegistry: {},
}));

vi.mock('./src-gpui/src/private/specs/NativeGpuiWindows', () => ({
  default: { windowGetStateSync: () => state.value },
}));

vi.mock('./src-gpui/src/private/desktop/windowContext', () => ({
  useDesktopWindowId: () => 1,
}));

vi.mock('./src-gpui/src/private/desktop/index', () => ({
  nativeRequest: async () => undefined,
}));

// A hook runner: slots persist across renders, effects run after a render.
let slots;
let cursor;
let effects;
let rerender;
vi.mock('react', () => ({
  useState: initial => {
    const index = cursor++;
    if (!(index in slots)) {
      slots[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [
      slots[index],
      value => {
        slots[index] =
          typeof value === 'function' ? value(slots[index]) : value;
        rerender();
      },
    ];
  },
  useRef: initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect: (effect, deps) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
      previous?.cleanup?.();
      effects.push(() => {
        slots[index] = { deps };
        slots[index].cleanup = effect();
      });
    }
  },
  createContext: () => ({}),
  useContext: () => 1,
}));

function mount(hook) {
  slots = {};
  effects = [];
  let result;
  const render = () => {
    cursor = 0;
    result = hook();
    const pending = effects;
    effects = [];
    pending.forEach(run => run());
  };
  rerender = render;
  render();
  return {
    get current() {
      return result;
    },
    unmount: () => Object.values(slots).forEach(slot => slot?.cleanup?.()),
  };
}

function emit(name, payload) {
  listeners.get(name)?.forEach(listener => listener(payload));
}

const windowState = overrides => ({
  windowId: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isMaximized: false,
  isFullscreen: false,
  isFocused: true,
  isMinimized: false,
  scaleFactor: 2,
  topInset: 0,
  ...overrides,
});

let useWindowState;
let useWindowFocus;

beforeEach(async () => {
  listeners.clear();
  state.value = windowState();
  ({ useWindowState, useWindowFocus } =
    await import('./src-gpui/src/private/desktop/windows'));
});

describe('useWindowState', () => {
  test('has real values on the first render', () => {
    const hook = mount(() => useWindowState());
    expect(hook.current.bounds.width).toBe(800);
  });

  test('updates on resize and stops listening on unmount', () => {
    const hook = mount(() => useWindowState());
    state.value = windowState({
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    emit('gpuiDesktop:windowResize', { windowId: 1 });
    expect(hook.current.bounds.width).toBe(400);
    hook.unmount();
    expect(listeners.get('gpuiDesktop:windowResize').size).toBe(0);
  });

  test('ignores events for another window', () => {
    const hook = mount(() => useWindowState());
    state.value = windowState({ isMaximized: true });
    emit('gpuiDesktop:windowStateChange', { windowId: 2 });
    expect(hook.current.isMaximized).toBe(false);
  });
});

describe('useWindowFocus', () => {
  test('follows focus and blur and ignores moves', () => {
    const hook = mount(() => useWindowFocus());
    expect(hook.current).toBe(true);
    emit('gpuiDesktop:windowBlur', { windowId: 1 });
    expect(hook.current).toBe(false);
    emit('gpuiDesktop:windowFocus', { windowId: 1 });
    expect(hook.current).toBe(true);
    expect(listeners.get('gpuiDesktop:windowMove')?.size ?? 0).toBe(0);
  });
});
