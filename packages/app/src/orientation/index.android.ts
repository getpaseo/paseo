import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { Dimensions } from "react-native";
import { useLayoutWindowWidth } from "@/constants/window-width";
import { getAndroidPhysicalScreenSize } from "./screen-geometry";
import { resolveAndroidOrientationPolicy } from "./policy";

export function useAdaptiveOrientation(): boolean {
  const layoutWindowWidth = useLayoutWindowWidth();
  const [screen, setScreen] = useState(getAndroidPhysicalScreenSize);
  const policy = resolveAndroidOrientationPolicy(screen);
  const [ready, setReady] = useState(() => policy === "system");

  useEffect(() => {
    const updateScreen = () => {
      const nextScreen = getAndroidPhysicalScreenSize();
      setScreen((current) =>
        current.width === nextScreen.width && current.height === nextScreen.height
          ? current
          : nextScreen,
      );
    };
    updateScreen();
    const subscription = Dimensions.addEventListener("change", updateScreen);
    return () => subscription.remove();
  }, [layoutWindowWidth]);

  useEffect(() => {
    let active = true;
    const request =
      policy === "portrait"
        ? ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        : ScreenOrientation.unlockAsync();

    void request
      .catch((error) => {
        console.warn("[Orientation] Could not apply Android screen orientation:", error);
      })
      .finally(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
    };
  }, [policy]);

  // An unrestricted native cold start can briefly report a landscape phone
  // window; wait for the portrait request before mounting layout content.
  return ready;
}
