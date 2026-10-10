import type { RefObject } from "react";
import type { View as ViewInstance } from "react-native";

/**
 * Preview Find is web-only: it highlights rendered text DOM, which does not
 * exist on native. Source mode falls back to FileFind's native behavior.
 */
export function FilePreviewFind(_props: { host: RefObject<ViewInstance | null> }) {
  return null;
}
