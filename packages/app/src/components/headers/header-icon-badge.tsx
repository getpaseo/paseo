import type { ReactNode } from "react";
import { View } from "react-native";
import { headerIconSlotStyle } from "./header-toggle-button";

/**
 * Non-interactive icon slot sitting at the start of a screen header's left
 * cluster. Shares the same padding + border-radius as `HeaderToggleButton` so
 * decorative headers (settings sections, host detail) line up with the sidebar
 * toggle across screens.
 */
export function HeaderIconBadge({ children }: { children: ReactNode }) {
  return <View style={headerIconSlotStyle.slot}>{children}</View>;
}
