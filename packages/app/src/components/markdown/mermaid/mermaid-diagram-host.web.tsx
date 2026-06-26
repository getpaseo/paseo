import { createElement, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import type { MermaidDiagramHostProps } from "@/components/markdown/mermaid/mermaid-diagram-host";

const webHostStyles = StyleSheet.create({
  intrinsicWrapper: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  fillWrapper: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});

export function MermaidDiagramHost({ svg, style, layout = "intrinsic" }: MermaidDiagramHostProps) {
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
      svgElement.style.maxHeight = "100%";
      svgElement.style.width = "auto";
      svgElement.style.height = "auto";
      svgElement.style.display = "block";
      svgElement.removeAttribute("height");
    }
  }, [svg]);

  const wrapperStyle = useMemo((): StyleProp<ViewStyle> => {
    const base = layout === "fill" ? webHostStyles.fillWrapper : webHostStyles.intrinsicWrapper;
    if (!style) {
      return base;
    }
    return [base, style];
  }, [layout, style]);

  if (!svg) {
    return null;
  }

  const hostDivStyle =
    layout === "fill"
      ? {
          width: "100%",
          height: "100%",
          minHeight: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          overflow: "hidden",
        }
      : {
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          overflow: "visible",
        };

  return (
    <View style={wrapperStyle}>
      {createElement("div", {
        ref: hostRef,
        style: hostDivStyle,
      })}
    </View>
  );
}
