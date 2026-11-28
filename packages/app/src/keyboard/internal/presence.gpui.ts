import { createHardwareKeyboardPresence } from "./hardware-presence";

export const hardwareKeyboardPresence = createHardwareKeyboardPresence({
  read: () => true,
  watch: () => () => {},
});
