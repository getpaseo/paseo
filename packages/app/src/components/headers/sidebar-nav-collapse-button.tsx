import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import type { ShortcutKey } from "@/utils/format-shortcut";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const NO_SHORTCUT: ShortcutKey[] = [];

interface SidebarNavCollapseButtonProps {
  collapsed: boolean;
  label: string;
  onPress: () => void;
}

/** Collapses the compact sidebar's nav block to its first row so the workspace list gets the room. */
export function SidebarNavCollapseButton({ collapsed, label, onPress }: SidebarNavCollapseButtonProps) {
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Glyph = collapsed ? ThemedChevronDown : ThemedChevronUp;

  return (
    <IconButtonChromeProvider value="header-island">
      <HeaderToggleButton
        onPress={onPress}
        tooltipLabel={label}
        tooltipKeys={NO_SHORTCUT}
        tooltipSide="bottom"
        testID="sidebar-nav-collapse"
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
      >
        <Glyph
          size={iconButtonChromeGlyphSize("large")}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </HeaderToggleButton>
    </IconButtonChromeProvider>
  );
}
