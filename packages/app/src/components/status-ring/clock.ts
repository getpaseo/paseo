import { useLayoutEffect } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { getStatusRingRotation } from "@/components/status-ring/geometry";

const sharedRotation = makeMutable(getStatusRingRotation(Date.now()));
const activeRingCount = makeMutable(0);
const clockRunning = makeMutable(false);

function advanceSharedRotation(): void {
  "worklet";
  if (activeRingCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  sharedRotation.value = getStatusRingRotation(Date.now());
  requestAnimationFrame(advanceSharedRotation);
}

function registerStatusRing(registered: SharedValue<boolean>): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  activeRingCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedRotation.value = getStatusRingRotation(Date.now());
    requestAnimationFrame(advanceSharedRotation);
  }
}

function unregisterStatusRing(registered: SharedValue<boolean>): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  activeRingCount.value -= 1;
}

export function useStatusRingRotation(): SharedValue<number> {
  const registered = useSharedValue(false);

  useLayoutEffect(() => {
    scheduleOnUI(registerStatusRing, registered);
    return () => {
      scheduleOnUI(unregisterStatusRing, registered);
    };
  }, [registered]);

  return sharedRotation;
}
