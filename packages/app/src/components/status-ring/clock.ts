import { useLayoutEffect, useState } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { getStatusPulseProgress, getStatusRingRotation } from "@/components/status-ring/geometry";

// One UI-thread clock for every running mark. Each frame reads the wall clock once and publishes
// both motions from it, so the rotation and the pulse can never drift apart.
const sharedRotation = makeMutable(getStatusRingRotation(Date.now()));
const sharedPulseProgress = makeMutable(getStatusPulseProgress(Date.now()));
const activeConsumerCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextListenerId = 1;

function publishSharedClock(nowMs: number): void {
  "worklet";
  sharedRotation.value = getStatusRingRotation(nowMs);
  sharedPulseProgress.value = getStatusPulseProgress(nowMs);
}

function advanceSharedClock(): void {
  "worklet";
  if (activeConsumerCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  publishSharedClock(Date.now());
  requestAnimationFrame(advanceSharedClock);
}

function registerConsumer(
  source: SharedValue<number>,
  local: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  activeConsumerCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    publishSharedClock(Date.now());
    requestAnimationFrame(advanceSharedClock);
  }

  local.value = source.value;
  source.addListener(listenerId, (value) => {
    local.value = value;
  });
}

function unregisterConsumer(
  source: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  source.removeListener(listenerId);
  activeConsumerCount.value -= 1;
}

function useSharedClockValue(source: SharedValue<number>, initial: number): SharedValue<number> {
  const active = useRetainedPanelActive();
  // Hidden retained views must not subscribe their animated styles to the shared clock.
  const local = useSharedValue(initial);
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextListenerId++);

  useLayoutEffect(() => {
    if (!active) return;
    scheduleOnUI(registerConsumer, source, local, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterConsumer, source, registered, listenerId);
    };
  }, [active, listenerId, local, registered, source]);

  return local;
}

export function useStatusRingRotation(): SharedValue<number> {
  return useSharedClockValue(sharedRotation, getStatusRingRotation(Date.now()));
}

export function useStatusPulseProgress(): SharedValue<number> {
  return useSharedClockValue(sharedPulseProgress, getStatusPulseProgress(Date.now()));
}
