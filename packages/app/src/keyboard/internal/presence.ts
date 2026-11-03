import { createHardwareKeyboardPresence } from "./hardware-presence";
import { getHardwareKeyboardPresent, subscribeHardwareKeyboardPresence } from "./sources/hardware";
export const hardwareKeyboardPresence = createHardwareKeyboardPresence({
  read: getHardwareKeyboardPresent,
  watch: subscribeHardwareKeyboardPresence,
});
