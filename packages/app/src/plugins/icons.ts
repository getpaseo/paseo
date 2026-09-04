import { createElement, type ReactElement } from "react";
import * as LucideIcons from "lucide-react-native";
import type { PluginIconProps } from "@getpaseo/plugin";
import type { LucideIcon } from "lucide-react-native";

function findPluginIcon(name: string): LucideIcon | null {
  const candidate = Reflect.get(LucideIcons, name);
  if (candidate === LucideIcons.Icon || candidate === LucideIcons.createLucideIcon) return null;
  const isComponent =
    typeof candidate === "function" ||
    (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate);
  return isComponent ? (candidate as LucideIcon) : null;
}

export function resolvePluginIcon(name: string): LucideIcon {
  const icon = findPluginIcon(name);
  if (!icon) throw new Error(`Unknown Lucide icon: ${name}`);
  return icon;
}

export function Icon({ name, size, color }: PluginIconProps): ReactElement | null {
  const icon = findPluginIcon(name);
  return icon ? createElement(icon, { size, color }) : null;
}
