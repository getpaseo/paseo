import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import * as webCatalogCache from "./catalog-cache.web";
import { afterEach, expect, it, vi } from "vitest";
const {
  parseCachedPluginCatalog,
  readCachedPluginCatalog,
  serializeCachedPluginCatalog,
  writeCachedPluginCatalog,
} = await vi.importActual<typeof import("./catalog-cache")>("./catalog-cache.ts");
import type { CachedPluginCatalogEntry } from "./catalog-cache-format";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-file-system", () => {
  class File {
    name: string;
    constructor(_root: string, _directory: string, name: string) {
      this.name = name;
    }
    get exists(): boolean {
      return files.has(this.name);
    }
    async text(): Promise<string> {
      return files.get(this.name) ?? "";
    }
    create(): void {}
    write(contents: string): void {
      files.set(this.name, contents);
    }
  }
  return { Paths: { document: "document://" }, File };
});

const entry: CachedPluginCatalogEntry = {
  id: "better-paseo",
  clientBundle: "bundle",
  requirements: { paseo: ">=0.12.0" },
};

afterEach(() => {
  files.clear();
});

it("round-trips catalog entries for a stable server id", async () => {
  await writeCachedPluginCatalog("host/1", [entry]);

  expect(files.has("host_1.json")).toBe(true);
  await expect(readCachedPluginCatalog("host/1")).resolves.toEqual([entry]);
});

it("rejects a cache the installer cannot trust", () => {
  expect(parseCachedPluginCatalog("not json")).toBeNull();
  expect(parseCachedPluginCatalog(JSON.stringify({ version: 2, entries: [entry] }))).toBeNull();
  expect(
    parseCachedPluginCatalog(
      JSON.stringify({ version: 1, entries: [{ id: "plugin", clientBundle: 1 }] }),
    ),
  ).toBeNull();
  expect(parseCachedPluginCatalog(serializeCachedPluginCatalog([entry]))).toEqual([entry]);
});

it("does not persist a placeholder server id", async () => {
  await writeCachedPluginCatalog("local:dev", [entry]);

  expect(files.size).toBe(0);
  await expect(readCachedPluginCatalog("local:dev")).resolves.toBeNull();
});

it("persists web catalogs across module reloads without losing exact host identities", async () => {
  vi.stubGlobal("indexedDB", fakeIndexedDB);
  try {
    await webCatalogCache.writeCachedPluginCatalog("host/one", [entry]);
    await webCatalogCache.writeCachedPluginCatalog("host_one", [
      { ...entry, clientBundle: "other host" },
    ]);
    vi.resetModules();
    const reopened = await import("./catalog-cache.web");
    await expect(reopened.readCachedPluginCatalog("host/one")).resolves.toEqual([entry]);
    await expect(reopened.readCachedPluginCatalog("host_one")).resolves.toEqual([
      { ...entry, clientBundle: "other host" },
    ]);
    await reopened.writeCachedPluginCatalog("host/one", [{ ...entry, clientBundle: "updated" }]);
    await expect(reopened.readCachedPluginCatalog("host/one")).resolves.toEqual([
      { ...entry, clientBundle: "updated" },
    ]);
    await reopened.writeCachedPluginCatalog("local:pending", [entry]);
    await expect(reopened.readCachedPluginCatalog("local:pending")).resolves.toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
