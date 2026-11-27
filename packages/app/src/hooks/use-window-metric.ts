import { useSyncExternalStore } from "react";
import { Dimensions, type ScaledSize } from "react-native";

function subscribe(notify: () => void) {
  const subscription = Dimensions.addEventListener("change", notify);
  return () => subscription.remove();
}

/** Only a change to the selected metric needs a React render. */
export function useWindowMetric<T>(select: (window: ScaledSize) => T): T {
  const snapshot = () => select(Dimensions.get("window"));
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
