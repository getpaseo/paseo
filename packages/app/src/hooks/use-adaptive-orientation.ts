import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect } from "react";
import { Dimensions, Platform } from "react-native";
import { resolveOrientationPolicy } from "@/constants/form-factor";

const isAndroid = Platform.OS === "android";

// Android rotates the app into landscape as soon as the window is wide enough,
// which drops phones into the tablet layout. `android:screenOrientation` has no
// screen-size qualifier, so the phone/tablet split has to happen here.
// A single read is enough: screen metrics do not change on rotation or resize.
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
