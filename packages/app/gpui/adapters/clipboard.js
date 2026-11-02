import { TurboModuleRegistry } from "react-native";
const clipboard = TurboModuleRegistry.getEnforcing("Clipboard");
export const getStringAsync = () => clipboard.getString();
export async function setStringAsync(value) {
  clipboard.setString(value);
  return true;
}
export async function hasStringAsync() {
  return (await getStringAsync()).length > 0;
}
export async function getImageAsync() {
  throw new Error("Image clipboard is not implemented for GPUI yet");
}
export async function setImageAsync() {
  throw new Error("Image clipboard is not implemented for GPUI yet");
}
