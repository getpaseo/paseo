import { useLayoutEffect, useState } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";

import {
  registerSmallWidgetClock,
  unregisterSmallWidgetClock,
  smallWidgetClockTime,
  type SmallWidgetClockPort,
} from "./small-widget-clock";

const clockPort: SmallWidgetClockPort = {
  time: makeMutable(smallWidgetClockTime(Date.now())),
  consumerCount: makeMutable(0),
  running: makeMutable(false),
  now() {
    "worklet";
    return Date.now();
  },
  requestFrame(callback) {
    "worklet";
    requestAnimationFrame(callback);
  },
};
let nextListenerId = 1;

export function useSmallWidgetClock(enabled = true): SharedValue<number> {
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  // A local value detaches hidden retained views from the clock's style updates.
  const time = useSharedValue(smallWidgetClockTime(Date.now()));
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextListenerId++);

  useLayoutEffect(() => {
    if (!enabled || !panelActive || !appVisible) return;
    scheduleOnUI(registerSmallWidgetClock, clockPort, time, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterSmallWidgetClock, clockPort, registered, listenerId);
    };
  }, [appVisible, enabled, listenerId, panelActive, registered, time]);

  return time;
}
