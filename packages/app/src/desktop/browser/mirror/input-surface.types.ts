import type { ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { BrowserViewerCommand } from "@getpaseo/protocol/browser-automation/client-command";
import type { GuestViewport, ViewportFit } from "./viewport";

export type BrowserMirrorInput = Extract<
  BrowserViewerCommand,
  { command: "input_at" }
>["args"]["event"];

/**
 * The pane owns the frame and the letterbox fit; the surface owns the pointer.
 * Platform files implement it differently — a mouse has phases and a wheel, a
 * touch has neither — so the props stay here where both can read them.
 */
export interface BrowserMirrorInputSurfaceProps {
  fit: ViewportFit | null;
  guest: GuestViewport;
  isInteractive: boolean;
  onInput: (event: BrowserMirrorInput) => void;
  onFocusKeyboard: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}
