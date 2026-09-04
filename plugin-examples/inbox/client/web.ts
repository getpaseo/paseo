import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
export interface WebKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
  preventDefault(): void;
}

declare const document: {
  addEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: WebKeyEvent) => void): void;
};

const NOOP = () => {};

/** Web only. Native has no document, so the subscription is a no-op there. */
export function subscribeKeydown(handler: (event: WebKeyEvent) => void): () => void {
  if (Platform.OS !== "web") return NOOP;
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/** True when the key event targets a text field, so board shortcuts must stay out of the way. */
export function isTextTarget(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
}
