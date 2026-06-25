import { createElement, useEffect, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

interface MermaidDiagramHostProps {
  svg: string;
  style?: StyleProp<ViewStyle>;
}

export function MermaidDiagramHost({ svg, style }: MermaidDiagramHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    host.innerHTML = svg;
    const svgElement = host.querySelector("svg");
    if (svgElement) {
      svgElement.style.maxWidth = "100%";
      svgElement.style.height = "auto";
      svgElement.removeAttribute("height");
    }
  }, [svg]);

  if (!svg) {
    return null;
  }

  return (
    <View style={style}>
      {createElement("div", {
        ref: hostRef,
        style: { width: "100%", overflow: "hidden" },
      })}
    </View>
  );
}
