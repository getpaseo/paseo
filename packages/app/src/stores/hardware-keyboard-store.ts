import { create } from "zustand";
import { isNative } from "@/constants/platform";
import {
  addHardwareKeyboardConnectionListener,
  getHardwareKeyboardConnected,
} from "@/native/hardware-keyboard-events";

interface HardwareKeyboardState {
  connected: boolean;
}

export const useHardwareKeyboardStore = create<HardwareKeyboardState>(() => ({
  connected: isNative ? getHardwareKeyboardConnected() : false,
}));

if (isNative) {
  addHardwareKeyboardConnectionListener(({ connected }) => {
    useHardwareKeyboardStore.setState({ connected });
  });
}
