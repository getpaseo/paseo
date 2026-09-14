import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect } from "react";
import { Dimensions, Platform } from "react-native";
import { resolveOrientationPolicy } from "@/constants/form-factor";

const isAndroid = Platform.OS === "android";

/**
 * Android rotates an app into landscape the moment its window gets wide enough,
 * which puts phones into the tablet layout. Keep phones portrait and let large
 * screens rotate, which is what Android 16 already does on its own.
 *
 * The manifest cannot express this: `android:screenOrientation` has no
 * screen-size qualifier, so the phone/tablet split has to happen at runtime.
 * iOS gets the same split from the Info.plist keys Expo writes and is skipped.
 *
 * Reads the physical screen rather than the window, so a tablet in a floating
 * or split window still unlocks. Screen metrics do not change on rotation or
 * window resize, so a single read at mount is enough.
 */
export function useAdaptiveOrientation(): void {
  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    const { width, height } = Dimensions.get("screen");
    const policy = resolveOrientationPolicy({
      isAndroid,
      screenWidth: width,
      screenHeight: height,
    });

    if (policy === "lock-portrait") {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } else if (policy === "follow-sensor") {
      void ScreenOrientation.unlockAsync();
    }
  }, []);
}
