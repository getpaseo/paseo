import { requireNativeView } from "expo";
import type { ViewProps } from "react-native";

/**
 * The composer input's container on Android. It takes the composer's send chords from a hardware
 * keyboard before the IME, which on some keyboards would turn a physical Return into a soft one
 * (HardwareKeyboardSubmitView in the paseo-hardware-keyboard module). Layout is React Native's.
 */
export const HardwareKeyboardSubmitScope = requireNativeView<ViewProps>("PaseoHardwareKeyboard");
