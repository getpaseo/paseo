import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ProjectIconCache, type ProjectIconCacheStorage } from "./icon-cache";

class MemoryStorage implements ProjectIconCacheStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const target = {
  serverId: "host-a",
  projectId: "project-a",
  iconWorkingDir: "/project-a",
  iconRevision: "revision-a",
};
const icon = { data: "aWNvbg==", mimeType: "image/png" };

function clientWith(iconResult: typeof icon | null) {
  return {
    getProjectIcon: async () => ({ requestId: "icon", icon: iconResult }),
  } as unknown as DaemonClient;
}

describe("ProjectIconCache", () => {
  it("resolves, persists, and hydrates an icon before a host connects", async () => {
    const storage = new MemoryStorage();
    const writer = new ProjectIconCache(storage);
    writer.setHosts([target.serverId]);
    await writer.query(target, true, () => clientWith(icon), true).queryFn();
    await writer.flush();

    const reader = new ProjectIconCache(storage);
    reader.setHosts([target.serverId]);
    await reader.restore();

    expect(reader.query(target, true, () => null, false).initialData).toEqual(icon);
  });

  it("persists an explicit no-icon result", async () => {
    const storage = new MemoryStorage();
    const writer = new ProjectIconCache(storage);
    writer.setHosts([target.serverId]);
    await writer.query(target, true, () => clientWith(null), true).queryFn();
    await writer.flush();

    const reader = new ProjectIconCache(storage);
    reader.setHosts([target.serverId]);
    await reader.restore();
    expect(reader.query(target, true, () => null, false)).toHaveProperty("initialData", null);
  });

  it("misses only the project whose revision changed", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    const other = { ...target, projectId: "project-b" };
    await cache.query(target, true, () => clientWith(icon), true).queryFn();
    await cache.query(other, true, () => clientWith(null), true).queryFn();

    expect(
      cache.query({ ...target, iconRevision: "revision-b" }, true, () => null, false),
    ).not.toHaveProperty("initialData");
    expect(cache.query(other, true, () => null, false)).toHaveProperty("initialData", null);
  });
});
