import { BackHandler, Platform } from "react-native";
import type { BackPressSource } from "./visibility-tracker";

/**
 * Android's hardware Back press.
 *
 * iOS and web have no such press, and `react-native-web`'s `BackHandler` logs an error as soon as
 * anything subscribes, so nothing is registered off Android.
 */
export const systemBackPress: BackPressSource = {
  subscribe(onBackPress) {
    if (Platform.OS !== "android") return () => {};
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  },
};
