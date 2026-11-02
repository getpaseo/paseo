import './customDirectEventTypes.desktop';

// GPUI always ships the native screens implementation.
export const isNativePlatformSupported = true;

let ENABLE_SCREENS = isNativePlatformSupported;

export function enableScreens(shouldEnableScreens = true) {
  ENABLE_SCREENS = shouldEnableScreens;
}

let ENABLE_FREEZE = false;

export function enableFreeze(shouldEnableReactFreeze = true) {
  if (!isNativePlatformSupported) {
    return;
  }

  ENABLE_FREEZE = shouldEnableReactFreeze;
}

export function screensEnabled() {
  return ENABLE_SCREENS;
}

export function freezeEnabled() {
  return ENABLE_FREEZE;
}
