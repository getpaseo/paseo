import type { HelloClientInfo, HelloClientPlatform } from "@getpaseo/protocol/daemon-clients";
import { getIsElectron } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

function mapDesktopPlatform(raw: string | undefined): HelloClientPlatform {
  const normalized = raw?.toLowerCase();
  if (normalized === "darwin" || normalized === "macos") return "macos";
  if (normalized === "linux") return "linux";
  if (normalized === "win32" || normalized === "windows") return "windows";
  return "unknown";
}

function parseBrowserName(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent) && !/Edg\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return "Safari";
  return undefined;
}

export function resolveAppClientIdentity(): {
  clientType: "mobile" | "browser";
  clientInfo: HelloClientInfo;
} {
  if (getIsElectron()) {
    const desktop = getDesktopHost();
    const label = desktop?.browserHostLabel?.trim();
    return {
      clientType: "mobile",
      clientInfo: {
        kind: "desktop",
        platform: mapDesktopPlatform(desktop?.platform),
        ...(label ? { name: label.slice(0, 128) } : {}),
      },
    };
  }

  const browserName =
    typeof navigator !== "undefined" ? parseBrowserName(navigator.userAgent) : undefined;
  return {
    clientType: "browser",
    clientInfo: {
      kind: "web",
      platform: "web",
      ...(browserName ? { name: browserName } : {}),
    },
  };
}
