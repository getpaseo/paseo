// @ts-nocheck
import { vi } from "vitest";

const globalWithTestShims = globalThis as typeof globalThis & Record<string, any>;

globalWithTestShims.__DEV__ = false;

if (typeof globalThis.self === "undefined") {
  globalWithTestShims.self = globalThis;
}

if (typeof globalThis.expo === "undefined") {
  class ExpoEventEmitter {
    addListener() {
      return {
        remove() {},
      };
    }
    removeListener() {}
    removeAllListeners() {}
    emit() {}
    listenerCount() {
      return 0;
    }
  }

  class ExpoSharedObject extends ExpoEventEmitter {}
  class ExpoSharedRef extends ExpoSharedObject {}
  class ExpoNativeModule extends ExpoEventEmitter {}

  globalWithTestShims.expo = {
    EventEmitter: ExpoEventEmitter,
    SharedObject: ExpoSharedObject,
    SharedRef: ExpoSharedRef,
    NativeModule: ExpoNativeModule,
    modules: {},
  };
}

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = (handle: number) => {
    clearTimeout(handle);
  };
}

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: <T>(styles: T) => styles,
  },
  useUnistyles: () => ({
    theme: {},
    rt: {},
    breakpoint: undefined,
  }),
  UnistylesRuntime: {
    setTheme: vi.fn(),
    themeName: "light",
  },
}));

vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class LigaturesAddon {},
}));

vi.mock("react-native-svg", () => {
  const Stub = () => null;
  return {
    __esModule: true,
    default: Stub,
    Circle: Stub,
    Defs: Stub,
    G: Stub,
    Line: Stub,
    LinearGradient: Stub,
    Path: Stub,
    Rect: Stub,
    Stop: Stub,
    SvgCss: Stub,
    SvgCssUri: Stub,
    SvgFromXml: Stub,
    SvgUri: Stub,
    SvgXml: Stub,
    Use: Stub,
  };
});

vi.mock("expo-linking", () => ({
  openURL: vi.fn().mockResolvedValue(undefined),
}));
