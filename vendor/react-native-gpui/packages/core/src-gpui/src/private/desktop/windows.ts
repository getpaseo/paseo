/**
 * `DesktopWindow` — window and title-bar control.
 *
 * Every method is a thin wrapper over the `GpuiDesktop` bridge. Methods the OS
 * cannot implement reject with `DesktopError('unsupported')`.
 *
 * @format
 */

import { useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter, processColor } from 'react-native';
import type { ColorValue } from 'react-native';
import NativeGpuiWindows from '../specs/NativeGpuiWindows';
import { nativeRequest } from './index';
import { useDesktopWindowId } from './windowContext';

/** Runs one `GpuiWindows` method with the shared module check. */
function request<T>(
  run: (native: NonNullable<typeof NativeGpuiWindows>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiWindows', check => run(check(NativeGpuiWindows)));
}

/// How many `closeRequested` listeners each window has.
///
/// The host intercepts the OS close itself, so it only needs telling when the
/// first listener arrives and the last one goes. Keeping the count here, per
/// window, is what lets two listeners coexist.
const closeInterceptors = new Map<number, number>();

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  windowId: number;
  bounds: WindowBounds;
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
  isMinimized: boolean;
  /** `false` after `hide()`. A minimized window is still visible. */
  isVisible: boolean;
  title: string;
  /** The content scale set with `setZoomFactor()`; `1` is the natural size. */
  zoomFactor: number;
  scaleFactor: number;
  /** How far a transparent title bar reaches into the content, in points. */
  topInset: number;
}

export interface OpenWindowOptions {
  component: string;
  props?: Record<string, unknown>;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  titleBar?: 'default' | 'transparent' | 'hidden' | 'none';
  /**
   * What shows through the window where the app draws nothing opaque. `'mica'`
   * is the Windows 11 material and leaves the window opaque elsewhere.
   */
  background?: 'opaque' | 'transparent' | 'blurred' | 'mica';
  /** Whether macOS draws the traffic lights. Defaults to `true`; other systems ignore it. */
  windowButtons?: boolean;
  /** Whether the window has the system shadow. Defaults to `true`; only macOS draws one yet. */
  shadow?: boolean;
  trafficLightPosition?: { x: number; y: number };
  resizable?: boolean;
  alwaysOnTop?: boolean;
  /**
   * Shows the window on every Space, over full-screen apps when it is also
   * `alwaysOnTop`. Check `capabilities().visibleOnAllWorkspaces`.
   */
  visibleOnAllWorkspaces?: boolean;
  parent?: number;
}

export type WindowEventName =
  'focus' | 'blur' | 'resize' | 'move' | 'stateChange' | 'closeRequested';

export interface WindowEvent {
  windowId: number;
  [key: string]: unknown;
}

export interface Subscription {
  remove(): void;
}

const EVENT_NAMES: Record<WindowEventName, string> = {
  focus: 'gpuiDesktop:windowFocus',
  blur: 'gpuiDesktop:windowBlur',
  resize: 'gpuiDesktop:windowResize',
  move: 'gpuiDesktop:windowMove',
  stateChange: 'gpuiDesktop:windowStateChange',
  closeRequested: 'gpuiDesktop:closeRequested',
};

export class DesktopWindow {
  readonly id: number;
  readonly component: string | undefined;

  constructor(id: number, component?: string) {
    this.id = id;
    this.component = component;
  }

  /**
   * The window this component is rendered in.
   *
   * This is a hook in disguise: call it unconditionally from a component body.
   * `useDesktopWindow()` is the same thing under a hook-shaped name.
   */
  static current(): DesktopWindow {
    // `current()` is a hook in disguise: it must be called during
    // render, exactly like `useDesktopWindow()`.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return new DesktopWindow(useDesktopWindowId());
  }

  static async open(options: OpenWindowOptions): Promise<DesktopWindow> {
    const result = await request(native => native.windowOpen(options));
    return new DesktopWindow(result.windowId);
  }

  static async all(): Promise<DesktopWindow[]> {
    const result = await request(native => native.windowList());
    return result.windows.map(
      entry => new DesktopWindow(entry.windowId, entry.component),
    );
  }

  getState(): Promise<WindowState> {
    return request(native =>
      native.windowGetState(this.id),
    ) as Promise<WindowState>;
  }

  /**
   * Ask the host to intercept the OS close button. With a `closeRequested`
   * listener installed, the wrapper turns this on so JS can veto.
   */
  interceptClose(on: boolean): Promise<void> {
    return request(native => native.windowInterceptClose(this.id, on));
  }

  close(options: { force?: boolean } = {}): Promise<void> {
    return request(native =>
      native.windowClose(this.id, options.force ?? false),
    );
  }

  focus(): Promise<void> {
    return request(native => native.windowFocus(this.id));
  }

  /** Moves keyboard focus to the next focusable view in tab order, as Tab does. */
  focusNext(): Promise<void> {
    return request(native => native.windowMoveFocus(this.id, false));
  }

  /** Moves keyboard focus to the previous focusable view in tab order, as Shift+Tab does. */
  focusPrevious(): Promise<void> {
    return request(native => native.windowMoveFocus(this.id, true));
  }

  setTitle(title: string): Promise<void> {
    return request(native => native.windowSetTitle(this.id, title));
  }

  /**
   * Scales the window's content: `1` is the natural size, `2` doubles it. The
   * factor is clamped to 0.25 to 5 and lasts until the window closes, so an app
   * that remembers it saves it itself (the `stateChange` event reports changes)
   * and sets it again on the next launch.
   */
  setZoomFactor(factor: number): Promise<void> {
    return request(native => native.windowSetZoomFactor(this.id, factor));
  }

  /** The factor set with `setZoomFactor()`. */
  async getZoomFactor(): Promise<number> {
    return (await this.getState()).zoomFactor;
  }

  /** The title set with `setTitle()` or `open()`. */
  async getTitle(): Promise<string> {
    return (await this.getState()).title;
  }

  /**
   * Paints the window behind its content, which shows while the window is
   * resized and wherever the content is transparent. macOS only for now.
   */
  setBackgroundColor(color: ColorValue): Promise<void> {
    const argb = processColor(color);
    if (typeof argb !== 'number') {
      return Promise.reject(
        new TypeError('setBackgroundColor needs a plain color'),
      );
    }
    return request(native => native.windowSetBackgroundColor(this.id, argb));
  }

  /**
   * Gives the window's native title bar and traffic lights a light or dark look,
   * or `'system'` to follow the system again. macOS only for now. A title bar the
   * app draws itself takes its colors from its styles.
   */
  setChromeAppearance(appearance: 'light' | 'dark' | 'system'): Promise<void> {
    return request(native =>
      native.windowSetChromeAppearance(this.id, appearance),
    );
  }

  setSize(size: { width: number; height: number }): Promise<void> {
    return request(native =>
      native.windowSetSize(this.id, size.width, size.height),
    );
  }

  setPosition(position: { x: number; y: number }): Promise<void> {
    return request(native =>
      native.windowSetPosition(this.id, position.x, position.y),
    );
  }

  setMinSize(size: { width: number; height: number }): Promise<void> {
    return request(native =>
      native.windowSetMinSize(this.id, size.width, size.height),
    );
  }

  setMaxSize(size: { width: number; height: number }): Promise<void> {
    return request(native =>
      native.windowSetMaxSize(this.id, size.width, size.height),
    );
  }

  setResizable(resizable: boolean): Promise<void> {
    return request(native => native.windowSetResizable(this.id, resizable));
  }

  minimize(): Promise<void> {
    return request(native => native.windowMinimize(this.id));
  }

  maximize(): Promise<void> {
    return request(native => native.windowMaximize(this.id));
  }

  unmaximize(): Promise<void> {
    return request(native => native.windowUnmaximize(this.id));
  }

  toggleMaximize(): Promise<void> {
    return request(native => native.windowToggleMaximize(this.id));
  }

  setFullscreen(fullscreen: boolean): Promise<void> {
    return request(native => native.windowSetFullscreen(this.id, fullscreen));
  }

  setAlwaysOnTop(onTop: boolean): Promise<void> {
    return request(native => native.windowSetAlwaysOnTop(this.id, onTop));
  }

  setVisibleOnAllWorkspaces(visible: boolean): Promise<void> {
    return request(native =>
      native.windowSetVisibleOnAllWorkspaces(this.id, visible),
    );
  }

  show(): Promise<void> {
    return request(native => native.windowShow(this.id));
  }

  hide(): Promise<void> {
    return request(native => native.windowHide(this.id));
  }

  startDragging(): Promise<void> {
    return request(native => native.windowStartDragging(this.id));
  }

  addListener(
    event: WindowEventName,
    listener: (event: WindowEvent) => void,
  ): Subscription {
    const name = EVENT_NAMES[event];
    const emitter = DeviceEventEmitter.addListener(name, (payload: unknown) => {
      const value = (payload ?? {}) as WindowEvent;
      if (value.windowId === this.id) {
        listener(value);
      }
    });
    if (event === 'closeRequested') {
      // Counted per window, so two listeners can coexist: the host intercepts
      // while at least one is attached, and removing one leaves the other
      // working. A plain true/false pair turned interception off for both.
      const count = (closeInterceptors.get(this.id) ?? 0) + 1;
      closeInterceptors.set(this.id, count);
      if (count === 1) {
        this.interceptClose(true);
      }
    }
    return {
      remove: () => {
        emitter.remove();
        if (event === 'closeRequested') {
          const count = Math.max(0, (closeInterceptors.get(this.id) ?? 1) - 1);
          if (count === 0) {
            closeInterceptors.delete(this.id);
            this.interceptClose(false);
          } else {
            closeInterceptors.set(this.id, count);
          }
        }
      },
    };
  }
}

export function useDesktopWindow(): DesktopWindow {
  return new DesktopWindow(useDesktopWindowId());
}

function readStateSync(windowId: number): WindowState | null {
  try {
    return (
      (NativeGpuiWindows?.windowGetStateSync(windowId) as WindowState) ?? null
    );
  } catch {
    return null;
  }
}

function sameState(a: WindowState | null, b: WindowState | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.windowId === b.windowId &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height &&
    a.isMaximized === b.isMaximized &&
    a.isFullscreen === b.isFullscreen &&
    a.isFocused === b.isFocused &&
    a.isMinimized === b.isMinimized &&
    a.isVisible === b.isVisible &&
    a.title === b.title &&
    a.zoomFactor === b.zoomFactor &&
    a.scaleFactor === b.scaleFactor &&
    a.topInset === b.topInset
  );
}

/**
 * The state of a window, kept current as it moves, resizes, changes state,
 * gains or loses focus. The first render already has real values; `null` only
 * for a window that is not open.
 */
export function useWindowState(windowIdOverride?: number): WindowState | null {
  const contextId = useDesktopWindowId();
  return useWindowStateSelector(
    windowIdOverride ?? contextId,
    state => state,
    sameState,
  );
}

/**
 * A value derived from a window's state. It re-renders only when the value
 * changes, so a field that a drag or resize leaves alone costs nothing while
 * the window moves. A `null` window is not subscribed to.
 */
export function useWindowStateSelector<T>(
  windowId: number | null,
  select: (state: WindowState | null) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const [value, setValue] = useState(() =>
    select(windowId === null ? null : readStateSync(windowId)),
  );
  const latest = useRef({ value, select, equal });
  latest.current = { value, select, equal };
  useEffect(() => {
    const update = () => {
      const current = latest.current;
      const next = current.select(
        windowId === null ? null : readStateSync(windowId),
      );
      if (!current.equal(current.value, next)) {
        current.value = next;
        setValue(() => next);
      }
    };
    update();
    if (windowId === null) {
      return;
    }
    const refresh = (event: WindowEvent) => {
      if (event.windowId === windowId) {
        update();
      }
    };
    const subscriptions = (
      ['focus', 'blur', 'resize', 'move', 'stateChange'] as const
    ).map(name => DeviceEventEmitter.addListener(EVENT_NAMES[name], refresh));
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [windowId]);
  return value;
}

/** Whether a window has focus. It does not re-render when the window moves. */
export function useWindowFocus(windowIdOverride?: number): boolean {
  const contextId = useDesktopWindowId();
  const windowId = windowIdOverride ?? contextId;
  const [focused, setFocused] = useState(
    () => readStateSync(windowId)?.isFocused ?? false,
  );
  useEffect(() => {
    const on = DeviceEventEmitter.addListener(
      EVENT_NAMES.focus,
      (event: WindowEvent) => {
        if (event?.windowId === windowId) setFocused(true);
      },
    );
    const off = DeviceEventEmitter.addListener(
      EVENT_NAMES.blur,
      (event: WindowEvent) => {
        if (event?.windowId === windowId) setFocused(false);
      },
    );
    setFocused(readStateSync(windowId)?.isFocused ?? false);
    return () => {
      on.remove();
      off.remove();
    };
  }, [windowId]);
  return focused;
}
