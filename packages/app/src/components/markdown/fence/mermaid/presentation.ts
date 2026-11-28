import type { MermaidFrame } from "@getpaseo/plugin/client/ui";
import type { TextStyle, ViewStyle } from "react-native";
import type { ViewportFitOptions } from "@/components/zoomable-viewport/geometry";
import { mermaidFrameStyle } from "./options";

export function getDiagramBoxStyle(style: TextStyle): ViewStyle {
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    borderWidth: style.borderWidth,
    padding: style.padding,
  };
}

export function getDiagramFrameStyle(frame: MermaidFrame | undefined): ViewStyle {
  return mermaidFrameStyle(frame);
}

export function getDiagramFit(
  style: TextStyle,
  frame: MermaidFrame | undefined,
): ViewportFitOptions | undefined {
  const frameStyle = mermaidFrameStyle(frame);
  const padding =
    frameStyle.padding ?? (typeof style.padding === "number" ? style.padding : undefined);
  return padding !== undefined ? { padding } : undefined;
}

/**
 * The viewport fits the diagram into the box minus the frame padding, so the padding has to
 * be part of the box height. Without it a diagram shorter than twice the padding is fitted
 * into a negative area, which clamps to a zero-size preview.
 */
export function getDiagramPreviewHeight(
  diagramHeight: number,
  fit: ViewportFitOptions | undefined,
): number {
  return Math.max(diagramHeight, 1) + (fit?.padding ?? 0) * 2;
}
