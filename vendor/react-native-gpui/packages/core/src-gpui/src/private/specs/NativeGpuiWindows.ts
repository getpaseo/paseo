import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowState = {
  windowId: CodegenTypes.Int32;
  bounds: WindowBounds;
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
  isMinimized: boolean;
  scaleFactor: number;
};

export type WindowHandle = {
  windowId: CodegenTypes.Int32;
};

export type WindowListEntry = {
  windowId: CodegenTypes.Int32;
  component: string;
};

export type WindowList = {
  windows: Array<WindowListEntry>;
};

export type WindowTrafficLights = {
  x: number;
  y: number;
};

export type WindowOpenOptions = {
  component: string;
  props?: Object;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  titleBar?: string;
  trafficLightPosition?: WindowTrafficLights;
  resizable?: boolean;
  alwaysOnTop?: boolean;
};

export interface Spec extends TurboModule {
  windowOpen(options: WindowOpenOptions): Promise<WindowHandle>;
  windowList(): Promise<WindowList>;
  windowGetState(windowId: CodegenTypes.Int32): Promise<WindowState>;
  windowClose(windowId: CodegenTypes.Int32, force: boolean): Promise<void>;
  windowFocus(windowId: CodegenTypes.Int32): Promise<void>;
  windowSetTitle(windowId: CodegenTypes.Int32, title: string): Promise<void>;
  windowSetSize(
    windowId: CodegenTypes.Int32,
    width: number,
    height: number,
  ): Promise<void>;
  windowSetPosition(
    windowId: CodegenTypes.Int32,
    x: number,
    y: number,
  ): Promise<void>;
  windowSetMinSize(
    windowId: CodegenTypes.Int32,
    width: number,
    height: number,
  ): Promise<void>;
  windowSetMaxSize(
    windowId: CodegenTypes.Int32,
    width: number,
    height: number,
  ): Promise<void>;
  windowSetResizable(
    windowId: CodegenTypes.Int32,
    resizable: boolean,
  ): Promise<void>;
  windowSetFullscreen(
    windowId: CodegenTypes.Int32,
    fullscreen: boolean,
  ): Promise<void>;
  windowSetAlwaysOnTop(
    windowId: CodegenTypes.Int32,
    onTop: boolean,
  ): Promise<void>;
  windowMinimize(windowId: CodegenTypes.Int32): Promise<void>;
  windowMaximize(windowId: CodegenTypes.Int32): Promise<void>;
  windowUnmaximize(windowId: CodegenTypes.Int32): Promise<void>;
  windowToggleMaximize(windowId: CodegenTypes.Int32): Promise<void>;
  windowShow(windowId: CodegenTypes.Int32): Promise<void>;
  windowHide(windowId: CodegenTypes.Int32): Promise<void>;
  windowStartDragging(windowId: CodegenTypes.Int32): Promise<void>;
  windowInterceptClose(
    windowId: CodegenTypes.Int32,
    on: boolean,
  ): Promise<void>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('GpuiWindows');
