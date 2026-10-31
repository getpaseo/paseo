import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_TIMELINE_CATALOG_TIMEOUT_MS,
  beginPluginCatalogLoad,
  beginPluginTimelineExpectationHydration,
  markPluginCatalogReady,
  pluginTimelinePaint,
  readPluginTimelinePaint,
  rememberPluginTimelineExpectation,
  resetPluginTimelinePaintState,
} from "./timeline-paint";

const storage = vi.hoisted(() => ({ raw: null as string | null }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => storage.raw),
    setItem: vi.fn(async (_key: string, value: string) => {
      storage.raw = value;
    }),
    removeItem: vi.fn(async () => {
      storage.raw = null;
    }),
  },
}));

describe("pluginTimelinePaint", () => {
  it("holds a chat that already has timeline plugins until the catalog is ready", () => {
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: true,
        pluginsFeature: null,
        catalogReady: false,
      }),
    ).toBe("wait");
  });

  it("paints once that catalog is installed", () => {
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: true,
        pluginsFeature: true,
        catalogReady: true,
      }),
    ).toBe("paint");
  });

  it("keeps painting a host that has no timeline plugins while a later catalog is loading", () => {
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: false,
        pluginsFeature: true,
        catalogReady: false,
      }),
    ).toBe("paint");
  });

  it("holds the first catalog on a plugin-capable host we have not seen before", () => {
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: "unknown",
        pluginsFeature: true,
        catalogReady: false,
      }),
    ).toBe("wait");
  });

  it("paints before server info when this host has no remembered timeline plugin", () => {
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: "unknown",
        pluginsFeature: null,
        catalogReady: false,
      }),
    ).toBe("paint");
    expect(
      pluginTimelinePaint({
        hydrated: true,
        expectation: false,
        pluginsFeature: null,
        catalogReady: false,
      }),
    ).toBe("paint");
  });

  it("holds until the remembered answer is loaded", () => {
    expect(
      pluginTimelinePaint({
        hydrated: false,
        expectation: false,
        pluginsFeature: null,
        catalogReady: false,
      }),
    ).toBe("wait");
    expect(
      pluginTimelinePaint({
        hydrated: false,
        expectation: true,
        pluginsFeature: true,
        catalogReady: true,
      }),
    ).toBe("paint");
  });
});

describe("plugin timeline paint state", () => {
  afterEach(() => {
    resetPluginTimelinePaintState();
    storage.raw = null;
    vi.useRealTimers();
  });

  it("restores a remembered timeline plugin and holds the chat until the catalog settles", async () => {
    storage.raw = JSON.stringify({ host: true });
    beginPluginTimelineExpectationHydration();
    await Promise.resolve();
    await Promise.resolve();

    expect(readPluginTimelinePaint("host", null)).toBe("wait");

    beginPluginCatalogLoad("host", { hasTransformers: false, forceWait: false });
    expect(readPluginTimelinePaint("host", true)).toBe("wait");

    markPluginCatalogReady("host");
    expect(readPluginTimelinePaint("host", null)).toBe("paint");
  });

  it("falls back to source rows when the catalog does not settle", async () => {
    vi.useFakeTimers();
    storage.raw = JSON.stringify({ host: true });
    beginPluginTimelineExpectationHydration();
    await Promise.resolve();
    await Promise.resolve();
    beginPluginCatalogLoad("host", { hasTransformers: false, forceWait: false });

    await vi.advanceTimersByTimeAsync(PLUGIN_TIMELINE_CATALOG_TIMEOUT_MS);

    expect(readPluginTimelinePaint("host", true)).toBe("paint");
  });

  it("remembers that a host has no timeline plugins", async () => {
    beginPluginTimelineExpectationHydration();
    await Promise.resolve();
    rememberPluginTimelineExpectation("host", false);
    await Promise.resolve();
    await Promise.resolve();

    resetPluginTimelinePaintState();
    beginPluginTimelineExpectationHydration();
    await Promise.resolve();
    await Promise.resolve();
    beginPluginCatalogLoad("host", { hasTransformers: false, forceWait: false });

    expect(readPluginTimelinePaint("host", true)).toBe("paint");
  });
});
