import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

/** The platform plugins see in `layout.platform`. */
export function resolvePluginPlatform(): PluginHostProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}
