import { beforeEach, describe, expect, test, vi } from "vitest";
import { useDownloadStore } from "./download-store";
import { createFakeDownloadPlatform, type FakeDownloadPlatform } from "./download-platform-fake";

// No module mocks: the store takes its filesystem and sharing through an injected port.

let platform: FakeDownloadPlatform;

beforeEach(() => {
  platform = createFakeDownloadPlatform();
  useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
});

function activeDownload() {
  return [...useDownloadStore.getState().downloads.values()][0];
}

describe("download store binary-channel path", () => {
  test("streams chunks to the cache file and never asks for an HTTP token", async () => {
    const requestFileDownloadToken = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "notes.txt",
      path: "notes.txt",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken,
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 6 });
        await sink.onChunk(new TextEncoder().encode("abc"));
        await sink.onChunk(new TextEncoder().encode("def"));
        return { fileName: "notes.txt", mimeType: "text/plain", size: 6 };
      },
    });

    expect(requestFileDownloadToken).not.toHaveBeenCalled();
    expect(platform.httpRequests).toEqual([]);
    expect(new TextDecoder().decode(platform.bytesFor("notes.txt"))).toBe("abcdef");
    expect(platform.shared).toEqual([{ uri: "file:///cache/notes.txt", mimeType: "text/plain" }]);
    expect(activeDownload()).toMatchObject({
      status: "complete",
      progress: { bytesWritten: 6, totalBytes: 6, percent: 1 },
    });
  });

  test("names the cache file from FileBegin so an archive keeps its extension", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "site",
      path: "site",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 0, sizeKnown: false, fileName: "site.zip" });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        return { fileName: "site.zip", mimeType: "application/zip", size: null };
      },
    });

    expect(platform.created).toEqual(["site.zip"]);
    expect(platform.shared[0]?.uri).toBe("file:///cache/site.zip");
  });

  test("treats an unknown archive size as indeterminate progress", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "src.zip",
      path: "src",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 0, sizeKnown: false });
        await sink.onChunk(new Uint8Array(64));
        return { fileName: "src.zip", mimeType: "application/zip", size: null };
      },
    });

    expect(activeDownload()).toMatchObject({
      status: "complete",
      progress: { bytesWritten: 64, totalBytes: 0, percent: 0, eta: 0 },
    });
  });

  test("removes the partial cache file when a transfer fails", async () => {
    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink }) => {
        sink.onBegin?.({ size: 100 });
        await sink.onChunk(new Uint8Array([1, 2, 3]));
        throw new Error("The host cancelled this transfer.");
      },
    });

    expect(platform.removed).toEqual(["big.bin"]);
    expect(activeDownload()).toMatchObject({
      status: "error",
      message: "The host cancelled this transfer.",
    });
  });

  test("cancelling an in-flight download aborts the signal the client is given", async () => {
    let aborted = false;

    const started = useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "big.bin",
      path: "big.bin",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken: vi.fn(),
      downloadEntry: async ({ sink, signal }) => {
        sink.onBegin?.({ size: 1000 });
        await sink.onChunk(new Uint8Array(10));
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new Error("Download cancelled.");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activeDownload().status).toBe("downloading");

    useDownloadStore.getState().cancelDownload(activeDownload().id);
    await started;

    expect(aborted).toBe(true);
    expect(activeDownload().status).toBe("error");
  });

  test("falls back to the HTTP token path when the host lacks the feature", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue({
      token: null,
      fileName: null,
      mimeType: null,
      error: "nope",
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv",
      scopeId: "scope",
      fileName: "notes.txt",
      path: "notes.txt",
      daemonProfile: undefined,
      platform,
      requestFileDownloadToken,
    });

    expect(requestFileDownloadToken).toHaveBeenCalledWith("notes.txt");
    expect(platform.created).toEqual([]);
    expect(activeDownload().status).toBe("error");
  });
});
