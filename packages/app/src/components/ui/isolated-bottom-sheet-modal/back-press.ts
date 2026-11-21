import { BackHandler, Platform } from "react-native";
import { createBackPressLayers } from "./back-press-layers";

/**
 * Android's hardware Back press, in two layers over one `BackHandler` listener.
 *
 * iOS and web have no such press, and `react-native-web`'s `BackHandler` logs an error as soon as
 * anything subscribes, so nothing is registered off Android.
 */
const layers = createBackPressLayers({
  subscribe(onBackPress) {
    if (Platform.OS !== "android") return () => {};
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  },
});

/** Overlays: bottom sheets, sheet tabs and the fullscreen composer. Offered Back first. */
export const systemBackPress = layers.overlay;

/** Screens, such as the compact workspace: offered Back only after every overlay declined it. */
export const screenBackPress = layers.screen;
