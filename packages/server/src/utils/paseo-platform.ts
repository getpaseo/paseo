import type { PaseoPlatform } from "@getpaseo/protocol/paseo-config-schema";

export function getCurrentPaseoPlatform(): PaseoPlatform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
