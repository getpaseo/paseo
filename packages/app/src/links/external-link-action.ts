/** A click on an http(s) link, from the terminal or rendered Markdown. */
export interface ExternalLinkClick {
  url: string;
  /** Viewport coordinates of the click. */
  clientX: number;
  clientY: number;
  /** Cmd on macOS, Ctrl elsewhere. */
  primaryModifier: boolean;
  shift: boolean;
}

export type ExternalLinkAction =
  | "show-popover"
  | "open-in-paseo-browser"
  | "open-in-system-browser";

export interface ExternalLinkActionInput {
  primaryModifier: boolean;
  shift: boolean;
  popoverEnabled: boolean;
  paseoBrowserAvailable: boolean;
}

export interface ExternalLinkMouseEvent {
  clientX: number;
  clientY: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export function readExternalLinkClick(input: {
  url: string;
  event: ExternalLinkMouseEvent;
  isMac: boolean;
}): ExternalLinkClick {
  const { url, event, isMac } = input;
  return {
    url,
    clientX: event.clientX,
    clientY: event.clientY,
    primaryModifier: isMac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
  };
}

export function resolveExternalLinkAction(input: ExternalLinkActionInput): ExternalLinkAction {
  if (!input.paseoBrowserAvailable) {
    return "open-in-system-browser";
  }
  if (input.primaryModifier) {
    return input.shift ? "open-in-system-browser" : "open-in-paseo-browser";
  }
  return input.popoverEnabled ? "show-popover" : "open-in-system-browser";
}
