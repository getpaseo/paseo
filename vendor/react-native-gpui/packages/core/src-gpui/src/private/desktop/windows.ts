/**
 * `DesktopWindow` — window and title-bar control.
 *
 * Every method is a thin wrapper over the `GpuiDesktop` bridge. Methods the OS
 * cannot implement reject with `DesktopError('unsupported')`.
 *
 * @format
 */

import { DeviceEventEmitter } from 'react-native';
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
  scaleFactor: number;
}

export interface OpenWindowOptions {
  component: string;
  props?: Record<string, unknown>;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  titleBar?: 'default' | 'transparent' | 'hidden';
  trafficLightPosition?: { x: number; y: number };
  resizable?: boolean;
  alwaysOnTop?: boolean;
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

  setTitle(title: string): Promise<void> {
    return request(native => native.windowSetTitle(this.id, title));
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
