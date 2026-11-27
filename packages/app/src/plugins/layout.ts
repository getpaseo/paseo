import type { PluginHostProps, PluginSafeAreaInsets } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type PluginLayout = PluginHostProps["layout"];

export function createPluginLayout(input: {
  compact: boolean;
  os: typeof Platform.OS;
  insets: PluginSafeAreaInsets;
}): PluginLayout {
  const { top, bottom, left, right } = input.insets;
  let platform: PluginLayout["platform"] = "web";
  if (input.os === "ios" || input.os === "android") platform = input.os;
  return { compact: input.compact, platform, insets: { top, bottom, left, right } };
}

/** The `layout` every plugin component receives. `compact` is the caller's form factor. */
export function usePluginLayout(compact: boolean): PluginLayout {
  const { top, bottom, left, right } = useSafeAreaInsets();
  return useMemo(
    () => createPluginLayout({ compact, os: Platform.OS, insets: { top, bottom, left, right } }),
    [bottom, compact, left, right, top],
  );
}
