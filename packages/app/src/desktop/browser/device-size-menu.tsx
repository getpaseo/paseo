import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import {
  ChevronDown,
  Maximize,
  Monitor,
  Smartphone,
  Tablet,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarButtonStyle } from "@/desktop/browser/chrome";

export type DeviceSizeId =
  | "responsive"
  | "iphone-se"
  | "iphone-14"
  | "iphone-14-pro-max"
  | "pixel-7"
  | "galaxy-s20"
  | "ipad-mini"
  | "ipad-air"
  | "ipad-pro-11"
  | "ipad-pro-12"
  | "surface-pro"
  | "laptop"
  | "desktop-1080"
  | "desktop-1440";

export interface DeviceSizePreset {
  id: DeviceSizeId;
  /** Display name (not translated — device names are proper nouns). */
  name: string;
  /** Fixed CSS width, or null for "fill the available area". */
  width: number | null;
  height: number | null;
  icon: LucideIcon;
}

// Viewport presets for the in-app browser. "responsive" fills the pane; the
// others render a fixed-size, centered frame so the user can preview how a page
// behaves at common device sizes. Content is centered (not left-aligned).
export const DEVICE_SIZE_PRESETS: readonly DeviceSizePreset[] = [
  { id: "responsive", name: "Responsive", width: null, height: null, icon: Maximize },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, icon: Smartphone },
  { id: "iphone-14", name: "iPhone 14", width: 390, height: 844, icon: Smartphone },
  { id: "iphone-14-pro-max", name: "iPhone 14 Pro Max", width: 430, height: 932, icon: Smartphone },
  { id: "pixel-7", name: "Pixel 7", width: 412, height: 915, icon: Smartphone },
  { id: "galaxy-s20", name: "Galaxy S20", width: 360, height: 800, icon: Smartphone },
  { id: "ipad-mini", name: "iPad Mini", width: 768, height: 1024, icon: Tablet },
  { id: "ipad-air", name: "iPad Air", width: 820, height: 1180, icon: Tablet },
  { id: "ipad-pro-11", name: 'iPad Pro 11"', width: 834, height: 1194, icon: Tablet },
  { id: "ipad-pro-12", name: 'iPad Pro 12.9"', width: 1024, height: 1366, icon: Tablet },
  { id: "surface-pro", name: "Surface Pro", width: 912, height: 1368, icon: Tablet },
  { id: "laptop", name: "Laptop", width: 1366, height: 768, icon: Monitor },
  { id: "desktop-1080", name: "Desktop 1080p", width: 1920, height: 1080, icon: Monitor },
  { id: "desktop-1440", name: "Desktop 1440p", width: 2560, height: 1440, icon: Monitor },
];

const RESPONSIVE_DEVICE_LABEL_KEY = "workspace.browser.devices.responsive";

function formatDevicePresetLabel(preset: DeviceSizePreset, responsiveLabel: string): string {
  const name = preset.id === "responsive" ? responsiveLabel : preset.name;
  if (preset.width && preset.height) {
    return `${name} · ${preset.width}×${preset.height}`;
  }
  return name;
}

// Lucide icons themed via withUnistyles so their color stays theme-reactive
// without a banned useUnistyles() call.
const ThemedMaximize = withUnistyles(Maximize);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);
const deviceMutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

function resolveThemedDeviceIcon(icon: LucideIcon): typeof ThemedMaximize {
  if (icon === Smartphone) return ThemedSmartphone;
  if (icon === Tablet) return ThemedTablet;
  if (icon === Monitor) return ThemedMonitor;
  return ThemedMaximize;
}

function DeviceSizeMenuItem({
  preset,
  selected,
  label,
  onSelect,
}: {
  preset: DeviceSizePreset;
  selected: boolean;
  label: string;
  onSelect: (id: DeviceSizeId) => void;
}) {
  const ThemedIcon = resolveThemedDeviceIcon(preset.icon);
  const handleSelect = useCallback(() => {
    onSelect(preset.id);
  }, [onSelect, preset.id]);
  const leading = useMemo(
    () => <ThemedIcon size={16} uniProps={deviceMutedIconMapping} />,
    [ThemedIcon],
  );
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
      leading={leading}
    >
      {label}
    </DropdownMenuItem>
  );
}

/**
 * Viewport picker shared by the local webview pane and the mirrored pane. The
 * caller owns what a preset means: the local pane resizes its own webview, the
 * mirror sends a `resize` command to the host that owns the tab.
 */
export function DeviceSizeMenu({
  selectedId,
  onSelect,
}: {
  selectedId: DeviceSizeId | null;
  onSelect: (id: DeviceSizeId) => void;
}) {
  const { t } = useTranslation();
  const selectedPreset =
    DEVICE_SIZE_PRESETS.find((preset) => preset.id === selectedId) ?? DEVICE_SIZE_PRESETS[0];
  const SelectedIcon = resolveThemedDeviceIcon(selectedPreset.icon);
  const label = t("workspace.browser.devices.label");
  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger accessibilityLabel={label} style={toolbarButtonStyle}>
            <View style={styles.deviceTrigger}>
              <SelectedIcon size={16} uniProps={deviceMutedIconMapping} />
              <ThemedChevronDown size={12} uniProps={deviceMutedIconMapping} />
            </View>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.toolbarTooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            label={formatDevicePresetLabel(preset, t(RESPONSIVE_DEVICE_LABEL_KEY))}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  deviceTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toolbarTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
