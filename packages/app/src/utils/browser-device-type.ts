export interface BrowserDeviceTypeInput {
  userAgent?: string | null;
  platform?: string | null;
  maxTouchPoints?: number | null;
}

const MOBILE_USER_AGENT_PATTERN = /android|iphone|ipad|ipod|mobile/i;

export function detectBrowserDeviceType(input: BrowserDeviceTypeInput): "web" | "mobile" {
  const userAgent = input.userAgent ?? "";
  const platform = input.platform ?? "";
  const maxTouchPoints = input.maxTouchPoints ?? 0;

  if (MOBILE_USER_AGENT_PATTERN.test(userAgent)) {
    return "mobile";
  }

  // iPadOS can present itself as "MacIntel" in desktop-class Safari.
  if (platform === "MacIntel" && maxTouchPoints > 1) {
    return "mobile";
  }

  return "web";
}

export function detectBrowserDeviceTypeFromNavigator(): "web" | "mobile" {
  if (typeof navigator === "undefined") {
    return "web";
  }

  return detectBrowserDeviceType({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}
