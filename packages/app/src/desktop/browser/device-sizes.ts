import { Maximize, Monitor, Smartphone, Tablet, type LucideIcon } from "lucide-react-native";

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
export function isPresetLandscape(preset: DeviceSizePreset): boolean {
  return preset.width !== null && preset.height !== null && preset.width > preset.height;
}

export function orientedSize(preset: DeviceSizePreset, isLandscape: boolean): DeviceSize | null {
  if (preset.width === null || preset.height === null) {
    return null;
  }
  if (isPresetLandscape(preset) === isLandscape) {
    return { width: preset.width, height: preset.height };
  }
  return { width: preset.height, height: preset.width };
}

export function formatDevicePresetLabel(
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
