import { createHash } from "node:crypto";

export const PASEO_BROWSER_HOST_PARTITION_PREFIX = "persist:paseo-browser-host-";

const HOST_PARTITION_PATTERN = /^persist:paseo-browser-host-[0-9a-f]{16}$/;

export function getHostBrowserProxyPartition(serverId: string): string {
  const normalized = serverId.trim();
  if (!normalized) {
    throw new Error("Host serverId is required to derive a browser proxy partition");
  }
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `${PASEO_BROWSER_HOST_PARTITION_PREFIX}${digest}`;
}

export function isHostBrowserProxyPartition(partition: string | undefined): partition is string {
  return typeof partition === "string" && HOST_PARTITION_PATTERN.test(partition);
}
