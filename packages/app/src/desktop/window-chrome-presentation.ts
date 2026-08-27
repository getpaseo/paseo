import { DESKTOP_WINDOW_CONTROLS_HEIGHT } from "@/constants/layout";
import type { DesktopWindowChromeMode } from "@/desktop/host";

export type CustomDesktopWindowChromeMode = Extract<
  DesktopWindowChromeMode,
  "custom-windows" | "custom-linux"
>;

export interface DesktopWindowControlsPresentation {
  controlWidth: number;
  railHeight: number;
  controlHeight: number;
  glyphSize: number;
  glyphStrokeWidth: number;
  hoverShape: "control" | "circle";
}

const PRESENTATION_BY_MODE: Record<
  CustomDesktopWindowChromeMode,
  DesktopWindowControlsPresentation
> = {
  "custom-windows": {
    controlWidth: 46,
    railHeight: DESKTOP_WINDOW_CONTROLS_HEIGHT,
    controlHeight: DESKTOP_WINDOW_CONTROLS_HEIGHT - 1,
    glyphSize: 16,
    glyphStrokeWidth: 1,
    hoverShape: "control",
  },
  "custom-linux": {
    controlWidth: 36,
    railHeight: DESKTOP_WINDOW_CONTROLS_HEIGHT,
    controlHeight: DESKTOP_WINDOW_CONTROLS_HEIGHT - 1,
    glyphSize: 14,
    glyphStrokeWidth: 1.5,
    hoverShape: "circle",
  },
};

export function getDesktopWindowControlsPresentation(
  mode: CustomDesktopWindowChromeMode,
): DesktopWindowControlsPresentation {
  return PRESENTATION_BY_MODE[mode];
}

export function getDesktopWindowControlsWidth(mode: CustomDesktopWindowChromeMode): number {
  return getDesktopWindowControlsPresentation(mode).controlWidth * 3;
}
