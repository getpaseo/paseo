import { DeviceEventEmitter } from "react-native";
import { createHardwareKeyboardSubmitBridge } from "./android-hardware-keyboard-bridge";

export const { setHardwareKeyboardSubmitEnabled, addHardwareKeyboardSubmitListener } =
  createHardwareKeyboardSubmitBridge(DeviceEventEmitter);
