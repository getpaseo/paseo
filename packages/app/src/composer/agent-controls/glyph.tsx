import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TOOLBAR_GLYPH_SIZES, type ToolbarGlyphs } from "@/components/ui/control-geometry";

/**
 * The slot a composer toolbar control's glyph sits in; see `toolbarGlyphsFor`. `label` when the
 * glyph sits beside a label, `icon` when the glyph is the whole control.
 */
export function ComposerToolbarGlyph({
  role,
  children,
}: {
  role: keyof ToolbarGlyphs;
  children: ReactNode;
}) {
  return (
    <View
      style={role === "label" ? styles.labelSlot : styles.iconSlot}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

const slot = { flexShrink: 0, alignItems: "center", justifyContent: "center" } as const;

const styles = StyleSheet.create({
  iconSlot: { ...slot, width: TOOLBAR_GLYPH_SIZES.icon, height: TOOLBAR_GLYPH_SIZES.icon },
  labelSlot: { ...slot, width: TOOLBAR_GLYPH_SIZES.label, height: TOOLBAR_GLYPH_SIZES.label },
});
