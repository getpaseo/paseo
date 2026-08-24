import * as LucideIcons from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

export function resolvePluginIcon(name: string): LucideIcon {
  const candidate = Reflect.get(LucideIcons, name);
  const isComponent =
    typeof candidate === "function" ||
    (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate);
  if (!isComponent) throw new Error(`Unknown Lucide icon: ${name}`);
  return candidate as LucideIcon;
}
