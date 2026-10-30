import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { PluginText } from "../text.js";
import type { PluginHostProps } from "./contracts.js";

export type PluginFloatingWidgetPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface PluginFloatingWidgetSize {
  width: number;
  height: number;
}

/** A touch target that lets Paseo distinguish taps, long presses, and dragging. */
export interface PluginFloatingWidgetDragHandleProps extends Pick<
  ViewProps,
  "children" | "style" | "testID" | "accessibilityLabel" | "accessibilityHint" | "accessibilityRole"
> {
  onPress?(): void;
  onLongPress?(): void;
  /** Defaults to 450ms. Moving more than 6 logical pixels cancels both press actions. */
  delayLongPress?: number;
}

/** An app-wide surface, with no implicit workspace or agent context. */
export interface PluginFloatingWidgetProps extends PluginHostProps {
  /** Available content size, reduced when the viewport or keyboard leaves less room. */
  size: PluginFloatingWidgetSize;
  /** Wrap only the interactive drag target; leave transparent surroundings outside this component. */
  DragHandle: ComponentType<PluginFloatingWidgetDragHandleProps>;
  hide(): void;
  /** With chrome: "none", collapse hides the widget; Show restores it through Command Center. */
  collapse(): void;
}

export interface PluginFloatingWidgetContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  Component: ComponentType<PluginFloatingWidgetProps>;
  /** Content dimensions in logical pixels; defaults to 160 × 160. */
  size?: PluginFloatingWidgetSize;
  /** Initial corner; subsequent placement belongs to the user. Defaults to bottom-right. */
  initialPosition?: PluginFloatingWidgetPosition;
  initiallyVisible?: boolean;
  /** Host controls, or content alone. Defaults to "toolbar"; Command Center controls remain available. */
  chrome?: "toolbar" | "none";
}

export interface PluginFloatingWidgetRegistration<Text extends PluginText = string> {
  update(patch: { title?: Text; size?: PluginFloatingWidgetSize }): void;
  /** Show and expand this installation's widget, selecting its host when several hosts contribute it. */
  show(): void;
  /** Hide this installation's widget. Paseo supplies a Command Center restore action. */
  hide(): void;
  remove(): void;
}
