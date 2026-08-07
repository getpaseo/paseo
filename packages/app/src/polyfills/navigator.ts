interface NavigatorPolyfillValue {
  userAgent?: unknown;
  platform?: unknown;
}

interface NavigatorPolyfillTarget {
  navigator?: NavigatorPolyfillValue;
}

function hasNavigator(value: NavigatorPolyfillValue | undefined): value is NavigatorPolyfillValue {
  return typeof value === "object" && value !== null;
}

export function polyfillNavigator(): void {
  const target = globalThis as unknown as NavigatorPolyfillTarget;

  if (!hasNavigator(target.navigator)) {
    target.navigator = {};
  }

  const navigator = target.navigator;
  if (typeof navigator.userAgent !== "string") {
    navigator.userAgent = "ReactNative";
  }
  if (typeof navigator.platform !== "string") {
    navigator.platform = "";
  }
}
