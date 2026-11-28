import Constants from "expo-constants";
import { Platform } from "react-native";
import type { HelloClientInfo, HelloClientPlatform } from "@getpaseo/protocol/daemon-clients";

function mapNativePlatform(os: string): HelloClientPlatform {
  if (os === "ios") return "ios";
  if (os === "android") return "android";
  return "unknown";
}

export function resolveAppClientIdentity(): {
  clientType: "mobile" | "browser";
  clientInfo: HelloClientInfo;
} {
  const deviceName = Constants.deviceName?.trim();
  return {
    clientType: "mobile",
    clientInfo: {
      kind: "mobile",
      platform: mapNativePlatform(Platform.OS),
      ...(deviceName ? { name: deviceName.slice(0, 128) } : {}),
    },
  };
}
