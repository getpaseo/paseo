import { describe, expect, test } from "vitest";
import {
  getHostBrowserProxyPartition,
  isHostBrowserProxyPartition,
  PASEO_BROWSER_HOST_PARTITION_PREFIX,
} from "./partition.js";

describe("host browser proxy partition naming", () => {
  test("produces deterministic 16-hex-char persistent partitions per serverId", () => {
    const first = getHostBrowserProxyPartition("srv_alpha_123");
    const second = getHostBrowserProxyPartition("srv_alpha_123");
    const other = getHostBrowserProxyPartition("srv_beta_456");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first.startsWith(PASEO_BROWSER_HOST_PARTITION_PREFIX)).toBe(true);
    expect(first).toMatch(/^persist:paseo-browser-host-[0-9a-f]{16}$/);
    expect(isHostBrowserProxyPartition(first)).toBe(true);
    expect(isHostBrowserProxyPartition(other)).toBe(true);
  });

  test("validates only exact host proxy partition format", () => {
    expect(isHostBrowserProxyPartition("persist:paseo-browser-host-0123456789abcdef")).toBe(true);
    expect(isHostBrowserProxyPartition("persist:paseo-browser")).toBe(false);
    expect(isHostBrowserProxyPartition("persist:paseo-browser-host-0123456789abcde")).toBe(false);
    expect(isHostBrowserProxyPartition("persist:paseo-browser-host-0123456789abcdef0")).toBe(false);
    expect(isHostBrowserProxyPartition("persist:paseo-browser-host-0123456789ABCDEF")).toBe(false);
    expect(isHostBrowserProxyPartition("persist:paseo-browser-host-zzzzzzzzzzzzzzzz")).toBe(false);
    expect(isHostBrowserProxyPartition("persist:foreign")).toBe(false);
    expect(isHostBrowserProxyPartition(undefined)).toBe(false);
  });
});
