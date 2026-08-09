export type BrowserDeviceSizeId =
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

export type BrowserDeviceKind = "responsive" | "phone" | "tablet" | "desktop";

export interface BrowserDeviceSizePreset {
  id: BrowserDeviceSizeId;
  /** Display names are device product names and intentionally are not translated. */
  name: string;
  width: number | null;
  height: number | null;
  kind: BrowserDeviceKind;
}

export const BROWSER_DEVICE_SIZE_PRESETS: readonly BrowserDeviceSizePreset[] = [
  {
    id: "responsive",
    name: "Responsive",
    width: null,
    height: null,
    kind: "responsive",
  },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, kind: "phone" },
  { id: "iphone-14", name: "iPhone 14", width: 390, height: 844, kind: "phone" },
  {
    id: "iphone-14-pro-max",
    name: "iPhone 14 Pro Max",
    width: 430,
    height: 932,
    kind: "phone",
  },
  { id: "pixel-7", name: "Pixel 7", width: 412, height: 915, kind: "phone" },
  { id: "galaxy-s20", name: "Galaxy S20", width: 360, height: 800, kind: "phone" },
  { id: "ipad-mini", name: "iPad Mini", width: 768, height: 1024, kind: "tablet" },
  { id: "ipad-air", name: "iPad Air", width: 820, height: 1180, kind: "tablet" },
  { id: "ipad-pro-11", name: 'iPad Pro 11"', width: 834, height: 1194, kind: "tablet" },
  {
    id: "ipad-pro-12",
    name: 'iPad Pro 12.9"',
    width: 1024,
    height: 1366,
    kind: "tablet",
  },
  { id: "surface-pro", name: "Surface Pro", width: 912, height: 1368, kind: "tablet" },
  { id: "laptop", name: "Laptop", width: 1366, height: 768, kind: "desktop" },
  {
    id: "desktop-1080",
    name: "Desktop 1080p",
    width: 1920,
    height: 1080,
    kind: "desktop",
  },
  {
    id: "desktop-1440",
    name: "Desktop 1440p",
    width: 2560,
    height: 1440,
    kind: "desktop",
  },
];

export const RESPONSIVE_BROWSER_DEVICE_LABEL_KEY = "workspace.browser.devices.responsive";

export function formatBrowserDevicePresetLabel(
  preset: BrowserDeviceSizePreset,
  responsiveLabel: string,
): string {
  const name = preset.id === "responsive" ? responsiveLabel : preset.name;
  if (preset.width && preset.height) {
    return `${name} · ${preset.width}×${preset.height}`;
  }
  return name;
}

export function getBrowserDevicePreset(id: BrowserDeviceSizeId): BrowserDeviceSizePreset {
  return (
    BROWSER_DEVICE_SIZE_PRESETS.find((preset) => preset.id === id) ??
    BROWSER_DEVICE_SIZE_PRESETS[0]!
  );
}
