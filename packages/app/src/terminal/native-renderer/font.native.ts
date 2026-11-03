import { Platform } from "react-native";
import { resolveTerminalFontFamily } from "../runtime/terminal-font";

const IOS_LOADED_MONO_FAMILIES: ReadonlySet<string> = new Set(["courier", "courier new", "menlo"]);

const ANDROID_LOADED_MONO_FAMILIES: ReadonlySet<string> = new Set([
  "monospace",
  "sans-serif-monospace",
]);

const IOS_MONO_ALIASES = new Map<string, string>([
  ["sf mono", "Menlo"],
  ["sfmono-regular", "Menlo"],
  ["ui-monospace", "Menlo"],
]);

const NATIVE_MONO_FALLBACK =
  Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) ?? "monospace";

function stripFontQuotes(family: string): string {
  const trimmed = family.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitFontStack(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map(stripFontQuotes)
    .filter((family) => family.length > 0);
}

function loadedNativeFontFamily(family: string): string | null {
  const normalized = family.toLowerCase();
  if (Platform.OS === "ios") {
    const alias = IOS_MONO_ALIASES.get(normalized);
    if (alias) return alias;
    return IOS_LOADED_MONO_FAMILIES.has(normalized) ? family : null;
  }
  if (Platform.OS === "android") {
    return ANDROID_LOADED_MONO_FAMILIES.has(normalized) ? family : null;
  }
  return normalized === "monospace" ? family : null;
}

export function resolveNativeTerminalFontFamily(fontFamily: string | undefined): string {
  const stack = resolveTerminalFontFamily(fontFamily);
  const loadedFamily = splitFontStack(stack)
    .map(loadedNativeFontFamily)
    .find((family): family is string => family !== null);
  return loadedFamily ?? NATIVE_MONO_FALLBACK;
}
