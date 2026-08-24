import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import {
  ChevronDown,
  Maximize,
  Monitor,
  RotateCw,
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
  DropdownMenuSeparator,
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
const LANDSCAPE_LABEL_KEY = "workspace.browser.devices.landscape";

export interface DeviceSize {
  width: number;
  height: number;
}

/**
 * What the menu resolved for the caller: which preset, which way round, and the
 * dimensions to apply. `size` is null for "responsive", which has no orientation
 * because it takes the shape of whatever area it is given.
 */
export interface DeviceSizeSelection {
  id: DeviceSizeId;
  isLandscape: boolean;
  size: DeviceSize | null;
}

/**
 * A preset stores one orientation — phones and tablets upright, laptops and
 * desktops wide — so `isLandscape` is absolute, not a swap flag: asking for the
 * orientation a preset is already in returns it unchanged.
 */
function isPresetLandscape(preset: DeviceSizePreset): boolean {
  return preset.width !== null && preset.height !== null && preset.width > preset.height;
}

function orientedSize(preset: DeviceSizePreset, isLandscape: boolean): DeviceSize | null {
  if (preset.width === null || preset.height === null) {
    return null;
  }
  if (isPresetLandscape(preset) === isLandscape) {
    return { width: preset.width, height: preset.height };
  }
  return { width: preset.height, height: preset.width };
}

function formatDevicePresetLabel(
  preset: DeviceSizePreset,
  responsiveLabel: string,
  size: DeviceSize | null,
): string {
  const name = preset.id === "responsive" ? responsiveLabel : preset.name;
  if (size) {
    return `${name} · ${size.width}×${size.height}`;
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
const ThemedRotateCw = withUnistyles(RotateCw);
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
  isLandscape,
  responsiveLabel,
  onSelect,
}: {
  preset: DeviceSizePreset;
  selected: boolean;
  isLandscape: boolean;
  responsiveLabel: string;
  onSelect: (selection: DeviceSizeSelection) => void;
}) {
  const ThemedIcon = resolveThemedDeviceIcon(preset.icon);
  const size = useMemo(() => orientedSize(preset, isLandscape), [isLandscape, preset]);
  const label = formatDevicePresetLabel(preset, responsiveLabel, size);
  const handleSelect = useCallback(() => {
    onSelect({ id: preset.id, isLandscape, size });
  }, [isLandscape, onSelect, preset.id, size]);
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
  isLandscape,
  onSelect,
}: {
  selectedId: DeviceSizeId | null;
  isLandscape: boolean;
  onSelect: (selection: DeviceSizeSelection) => void;
}) {
  const { t } = useTranslation();
  const selectedPreset =
    DEVICE_SIZE_PRESETS.find((preset) => preset.id === selectedId) ?? DEVICE_SIZE_PRESETS[0];
  const SelectedIcon = resolveThemedDeviceIcon(selectedPreset.icon);
  const label = t("workspace.browser.devices.label");
  const responsiveLabel = t(RESPONSIVE_DEVICE_LABEL_KEY);
  // "Responsive" fills the pane it is shown in, so it has no orientation of its
  // own and the row would do nothing.
  const canRotate = selectedPreset.id !== "responsive";
  const orientationIcon = useMemo(
    () => <ThemedRotateCw size={16} uniProps={deviceMutedIconMapping} />,
    [],
  );
  const toggleOrientation = useCallback(() => {
    onSelect({
      id: selectedPreset.id,
      isLandscape: !isLandscape,
      size: orientedSize(selectedPreset, !isLandscape),
    });
  }, [isLandscape, onSelect, selectedPreset]);
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
        {canRotate ? (
          <>
            <DropdownMenuItem
              onSelect={toggleOrientation}
              selected={isLandscape}
              showSelectedCheck
              leading={orientationIcon}
            >
              {t(LANDSCAPE_LABEL_KEY)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            isLandscape={preset.id === selectedId ? isLandscape : isPresetLandscape(preset)}
            responsiveLabel={responsiveLabel}
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
