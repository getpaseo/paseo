import { X } from "lucide-react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import type { ShortcutKey } from "@/utils/format-shortcut";

const ThemedX = withUnistyles(X);
const NO_SHORTCUT: ShortcutKey[] = [];

interface SidebarCloseButtonProps {
  label: string;
  onPress: () => void;
  testID: string;
  nativeID?: string;
  accessibilityState?: { expanded: boolean };
  style?: StyleProp<ViewStyle>;
}

/**
 * The X that closes a compact sidebar overlay. It is the compact header's icon button, so the
 * sidebar's close reads like the header it covers; every compact sidebar uses it.
 */
export function SidebarCloseButton({
  label,
  onPress,
  testID,
  nativeID,
  accessibilityState,
  style,
}: SidebarCloseButtonProps) {
  return (
    <IconButtonChromeProvider value="header-island">
      <HeaderToggleButton
        onPress={onPress}
        tooltipLabel={label}
        tooltipKeys={NO_SHORTCUT}
        tooltipSide="bottom"
        style={style}
        testID={testID}
        nativeID={nativeID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
      >
        <ThemedX
          size={iconButtonChromeGlyphSize("large")}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </HeaderToggleButton>
    </IconButtonChromeProvider>
  );
}
