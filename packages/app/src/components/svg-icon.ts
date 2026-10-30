import { Bot } from "lucide-react-native";
import { createElement } from "react";
import { SvgXml } from "react-native-svg";
import type { PluginIconProps } from "@getpaseo/plugin";

function reportInvalidSvg(error: unknown): void {
  console.warn("[Icons] Unable to render SVG", error);
}

/** Draws a validated SVG. Malformed XML keeps its surface usable with a generic icon. */
export function SvgIcon({ svg, size, color }: PluginIconProps & { svg: string }) {
  return createElement(SvgXml, {
    xml: svg,
    width: size,
    height: size,
    color,
    fallback: createElement(Bot, { size, color }),
    onError: reportInvalidSvg,
  });
}
