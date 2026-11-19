import type { Compartment, Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import { zoomedFontSize } from "@/text-zoom/model";
import { useScopedTextZoom } from "@/text-zoom/scope";
import { getTextZoomPinch } from "@/text-zoom/store";
import type { EditorVisualTheme } from "./extensions.web";

/** The editor theme at the file views' text zoom. */
export function useZoomedEditorTheme(theme: EditorVisualTheme): EditorVisualTheme {
  const zoom = useScopedTextZoom();
  return useMemo(
    () =>
      zoom === 1 ? theme : { ...theme, codeFontSize: zoomedFontSize(theme.codeFontSize, zoom) },
    [theme, zoom],
  );
}

/**
 * Applies a new theme. When only colours change the scroll position stays. When the font size
 * changes during a pinch, the line under the fingers stays under them; otherwise the line at the
 * top stays at the top.
 */
export function reconfigureEditorTheme(input: {
  view: EditorView;
  compartment: Compartment;
  theme: Extension;
  fontSizeChanged: boolean;
  extra?: StateEffect<unknown>[];
}): void {
  const effects: StateEffect<unknown>[] = [
    ...(input.extra ?? []),
    input.compartment.reconfigure(input.theme),
  ];
  if (input.fontSizeChanged) effects.push(scrollAnchor(input.view));
  input.view.dispatch({ effects });
}

function scrollAnchor(view: EditorView): StateEffect<unknown> {
  const focal = getTextZoomPinch()?.focal;
  const position = focal ? view.posAtCoords(focal, false) : null;
  if (!focal || position === null) return view.scrollSnapshot();
  const top = view.scrollDOM.getBoundingClientRect().top;
  return EditorView.scrollIntoView(position, { y: "start", yMargin: Math.max(0, focal.y - top) });
}
