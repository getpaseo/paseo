import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import * as webCatalogCache from "./catalog-cache.web";
import { readFileCachedPluginCatalog, writeFileCachedPluginCatalog } from "./catalog-cache-file";
import {
  parseCachedPluginCatalog,
  serializeCachedPluginCatalog,
  type CachedPluginCatalogEntry,
} from "./catalog-cache-format";
import { createTestCatalogCacheStorage } from "./test-catalog-cache-storage";

const entry: CachedPluginCatalogEntry = {
  id: "better-paseo",
  clientBundle: "bundle",
  requirements: { paseo: ">=0.12.0" },
};

it("stores each server's catalog in its own directory entry", async () => {
  const storage = createTestCatalogCacheStorage();
  await writeFileCachedPluginCatalog("host/one", [entry], storage);
  await writeFileCachedPluginCatalog(
    "host_one",
    [{ ...entry, clientBundle: "other host" }],
    storage,
  );

  expect(storage.directories).toEqual(new Set(["plugin-catalogs"]));
  expect([...storage.files.keys()]).toEqual([
    "plugin-catalogs/host%2Fone.json",
    "plugin-catalogs/host_one.json",
  ]);
  await expect(readFileCachedPluginCatalog("host/one", storage)).resolves.toEqual([entry]);
  await expect(readFileCachedPluginCatalog("host_one", storage)).resolves.toEqual([
    { ...entry, clientBundle: "other host" },
  ]);
});

it("replaces the file when the catalog changes", async () => {
  const storage = createTestCatalogCacheStorage();
  await writeFileCachedPluginCatalog("host", [entry], storage);
  await writeFileCachedPluginCatalog("host", [{ ...entry, clientBundle: "updated" }], storage);

  expect(storage.files.size).toBe(1);
  await expect(readFileCachedPluginCatalog("host", storage)).resolves.toEqual([
    { ...entry, clientBundle: "updated" },
  ]);
});

it("reads a missing file as a cache miss", async () => {
  const storage = createTestCatalogCacheStorage();

  await expect(readFileCachedPluginCatalog("host", storage)).resolves.toBeNull();
});

it("rejects a stored file the installer cannot trust", async () => {
  const storage = createTestCatalogCacheStorage();
  await storage.makeDirectory("plugin-catalogs");
  storage.setFile("plugin-catalogs/host.json", JSON.stringify({ version: 2, entries: [entry] }));

  await expect(readFileCachedPluginCatalog("host", storage)).resolves.toBeNull();
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
  const storage = createTestCatalogCacheStorage();
  await writeFileCachedPluginCatalog("local:dev", [entry], storage);

  expect(storage.directories.size).toBe(0);
  expect(storage.files.size).toBe(0);
  await expect(readFileCachedPluginCatalog("local:dev", storage)).resolves.toBeNull();
});

it("persists web catalogs across module reloads without losing exact host identities", async () => {
  vi.stubGlobal("indexedDB", fakeIndexedDB);
  try {
    await webCatalogCache.writeCachedPluginCatalog("host/one", [entry]);
    await webCatalogCache.writeCachedPluginCatalog("host_one", [
      { ...entry, clientBundle: "other host" },
    ]);
    // A reload drops the module-level database handle; a static import cannot exercise that.
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
