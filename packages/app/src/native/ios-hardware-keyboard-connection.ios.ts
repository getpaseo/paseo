import { requireNativeModule } from "expo-modules-core";
import { createHardwareKeyboardConnectionStore } from "./hardware-keyboard-connection-store";

interface PaseoHardwareKeyboardModule {
  isHardwareKeyboardConnected(): boolean;
  addListener(
    eventName: "onHardwareKeyboardConnectionChange",
    handler: (event: { connected: boolean }) => void,
  ): unknown;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

const store = createHardwareKeyboardConnectionStore({
  isConnected: () => module.isHardwareKeyboardConnected(),
  addListener: (handler) => {
    module.addListener("onHardwareKeyboardConnectionChange", (event) => handler(event.connected));
  },
});

export function subscribeHardwareKeyboardConnection(onChange: () => void): () => void {
  return store.subscribe(onChange);
}

export function getHardwareKeyboardConnected(): boolean {
  return store.getSnapshot();
}
