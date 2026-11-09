import { useCallback, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { TOOLBAR_CONTROL_GAP } from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { PluginComposerItems } from "@/plugins/composer-items";

/** A retained tab under `display: none` reports 0 by 0; see `styles.slot` for why 0 wide is real. */
function readSlotWidth(event: LayoutChangeEvent): number | null {
  const { width, height } = event.nativeEvent.layout;
  return height > 0 ? width : null;
}

/** What the plugin items take up in the toolbar row, in points, as `PluginToolbarSlot` reports it. */
export function usePluginToolbarWidth(): {
  width: number;
  onLayout: (event: LayoutChangeEvent) => void;
} {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = readSlotWidth(event);
    if (next !== null) setWidth(next);
  }, []);
  return { width, onLayout };
}

/**
 * The plugin items in their toolbar form, measured whether or not the toolbar shows them. An item
 * is an arbitrary component, so its width is known only from rendering it, and it is always the
 * toolbar form that is measured: the width never depends on the density it decides, so moving the
 * items to the overflow sheet cannot change the answer. Out of the row, the same node stays
 * mounted and measured, unseen and out of reach, and inactive so an open picker closes with it.
 */
export function PluginToolbarSlot({
  serverId,
  width,
  fits,
  onLayout,
}: {
  serverId: string | null;
  width: number;
  /** Whether the toolbar has room for the items at the width they measured. */
  fits: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  // An empty slot stays out of the row, or the row's gap would reserve room for nothing.
  const inline = fits && width > 0;
  return (
    <View
      style={[styles.slot, !inline && styles.measuring]}
      onLayout={onLayout}
      testID="plugin-toolbar-items"
      accessibilityElementsHidden={!inline}
      importantForAccessibility={inline ? "auto" : "no-hide-descendants"}
      aria-hidden={!inline}
    >
      <RetainedPanelActivity active={inline}>
        <PluginComposerItems serverId={serverId} surface="toolbar" />
      </RetainedPanelActivity>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: TOOLBAR_CONTROL_GAP,
    // Keeps a slot whose items render nothing distinguishable from one that is not rendered.
    minHeight: 1,
  },
  measuring: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    pointerEvents: "none",
    ...(isWeb ? ({ visibility: "hidden" } as const) : null),
  },
});
