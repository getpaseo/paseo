import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HostProfile } from "@/types/host-connection";

vi.mock("expo-file-system", () => ({
  File: class {
    exists = false;
    uri = "file:///tmp/download";
    write = vi.fn();
  },
  Paths: {
    cache: "file:///tmp",
    document: "file:///tmp",
  },
}));

vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: vi.fn(),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

import { MAX_RELAY_DOWNLOAD_BYTES, useDownloadStore } from "./download-store";

const profile: HostProfile = {
  serverId: "server-1",
  label: "Test server",
  lifecycle: {},
  connections: [
    {
      id: "direct:localhost:6767",
      type: "directTcp",
      endpoint: "localhost:6767",
    },
    {
      id: "relay:relay.paseo.sh",
      type: "relay",
      relayEndpoint: "relay.paseo.sh",
      daemonPublicKeyB64: "public-key",
    },
  ],
  preferredConnectionId: "direct:localhost:6767",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relay-download");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  useDownloadStore.setState({
    downloads: new Map(),
    activeDownloadId: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("download store relay fallback", () => {
  test("uses relay bytes when the active connection is relay even if localhost is configured", async () => {
    const requestFileBytes = vi.fn(async () => ({
      bytes: new TextEncoder().encode("# Index"),
      mime: "text/markdown",
      size: 7,
    }));

    await useDownloadStore.getState().startDownload({
      serverId: "server-1",
      scopeId: "workspace-1",
      fileName: "INDEX.md",
      path: "INDEX.md",
      daemonProfile: profile,
      activeConnectionId: "relay:relay.paseo.sh",
      supportsRelayFileDownloads: true,
      requestFileDownloadToken: vi.fn(async () => ({
        token: "unused-relay-token",
        fileName: "INDEX.md",
        mimeType: "text/markdown",
        size: 7,
        error: null,
      })),
      requestFileBytes,
    });

    expect(requestFileBytes).toHaveBeenCalledWith("INDEX.md");
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  test("keeps direct HTTP downloads on the active direct connection", async () => {
    const requestFileBytes = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "server-1",
      scopeId: "workspace-1",
      fileName: "INDEX.md",
      path: "INDEX.md",
      daemonProfile: profile,
      activeConnectionId: "direct:localhost:6767",
      supportsRelayFileDownloads: true,
      requestFileDownloadToken: vi.fn(async () => ({
        token: "direct-token",
        fileName: "INDEX.md",
        mimeType: "text/markdown",
        size: 7,
        error: null,
      })),
      requestFileBytes,
    });

    expect(requestFileBytes).not.toHaveBeenCalled();
    expect([...useDownloadStore.getState().downloads.values()][0]?.status).toBe("complete");
  });

  test("rejects oversized relay downloads before requesting file bytes", async () => {
    const requestFileBytes = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "server-1",
      scopeId: "workspace-1",
      fileName: "archive.zip",
      path: "archive.zip",
      daemonProfile: profile,
      activeConnectionId: "relay:relay.paseo.sh",
      supportsRelayFileDownloads: true,
      requestFileDownloadToken: vi.fn(async () => ({
        token: "unused-relay-token",
        fileName: "archive.zip",
        mimeType: "application/zip",
        size: MAX_RELAY_DOWNLOAD_BYTES + 1,
        error: null,
      })),
      requestFileBytes,
    });

    expect(requestFileBytes).not.toHaveBeenCalled();
    const result = [...useDownloadStore.getState().downloads.values()][0];
    expect(result?.status).toBe("error");
    expect(result?.message).toContain("32 MB");
  });
});
