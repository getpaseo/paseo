import { DeviceEventEmitter } from "react-native";

let enabled = false;

export function setHardwareKeyboardSubmitEnabled(nextEnabled: boolean) {
  enabled = nextEnabled;
}

export function addHardwareKeyboardSubmitListener(handler: () => void) {
  return DeviceEventEmitter.addListener("paseoHardwareKeyboardSubmit", () => {
    if (enabled) handler();
  });
}
