import { useState } from "react";
import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useKeyboardShift } from "./context";
import { shouldPublishSettledKeyboardShift } from "./policy";

/** Read the keyboard inset once each keyboard motion has settled, never per animation frame. */
export function useSettledKeyboardShift(): number {
  const { shift, isMoving } = useKeyboardShift();
  const [settledShift, setSettledShift] = useState(0);
  useAnimatedReaction(
    () => ({ moving: isMoving.value, shift: shift.value }),
    (current, previous) => {
      if (shouldPublishSettledKeyboardShift({ current, previous })) {
        scheduleOnRN(setSettledShift, current.shift);
      }
    },
    [isMoving, shift],
  );
  return settledShift;
}
