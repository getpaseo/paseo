import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { Dimensions, Platform } from "react-native";
import { resolveOrientationPolicy } from "@/constants/form-factor";

const isAndroid = Platform.OS === "android";

// Android rotates the app into landscape as soon as the window is wide enough,
// which drops phones into the tablet layout. `android:screenOrientation` has no
// screen-size qualifier, so the phone/tablet split has to happen here.
// A single read is enough: screen metrics do not change on rotation or resize.
// Returns whether the phone's portrait lock is in place. Android starts with
// unrestricted orientation, so callers must hold layout-dependent content until
// this flips — a phone cold-started in landscape would otherwise paint a
// landscape frame and briefly mount the tablet layout.
export function useAdaptiveOrientation(): boolean {
  const [isPortraitLockApplied, setIsPortraitLockApplied] = useState(!isAndroid);

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
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        .catch((error) => {
          console.warn("[AdaptiveOrientation] Portrait lock failed:", error);
        })
        .finally(() => setIsPortraitLockApplied(true));
    } else if (policy === "follow-sensor") {
      void ScreenOrientation.unlockAsync();
      setIsPortraitLockApplied(true);
    }
  }, []);

  return isPortraitLockApplied;
}
