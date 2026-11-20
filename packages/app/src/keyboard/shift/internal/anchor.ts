import { useContext, useMemo } from "react";
import { useDerivedValue, type DerivedValue } from "react-native-reanimated";
import {
  KeyboardTranslationContext,
  useKeyboardShift,
  type KeyboardTranslationScope,
} from "./context";
import { resolveKeyboardLift } from "./policy";

export interface KeyboardAnchor extends KeyboardTranslationScope {
  /** The anchor's lift at keyboard boundaries. Bound overlay height with this, never per frame. */
  reservedLift: DerivedValue<number>;
}

/**
 * Position portal content against an element inside a `KeyboardTranslateView`.
 * Lay the content out from `measureAtRest` and pass `translation` to a portal'd
 * `KeyboardTranslateView`: the content then rides the anchor's own animation
 * driver, frame for frame.
 */
export function useKeyboardAnchor(): KeyboardAnchor {
  const { translation, measureAtRest } = useContext(KeyboardTranslationContext);
  const { layoutShift } = useKeyboardShift();
  const reservedLift = useDerivedValue(() =>
    resolveKeyboardLift({ shift: layoutShift.value, ...translation }),
  );
  return useMemo(
    () => ({ measureAtRest, translation, reservedLift }),
    [measureAtRest, reservedLift, translation],
  );
}
