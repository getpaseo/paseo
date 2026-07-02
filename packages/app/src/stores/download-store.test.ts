import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { useDownloadStore } from "./download-store";

const fsMock = vi.hoisted(() => ({
  writes: new Map<string, Uint8Array>(),
  pendingWrite: null as Promise<void> | null,
}));
const platformMock = vi.hoisted(() => ({
  isWeb: false,
}));
const legacyFileSystemMock = vi.hoisted(() => ({
  createDownloadResumable: vi.fn(() => ({
    downloadAsync: vi.fn().mockResolvedValue({ uri: "file:///cache/report.txt" }),
  })),
}));

vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return platformMock.isWeb;
  },
}));

vi.mock("expo-file-system", () => {
  class File {
    readonly uri: string;

    constructor(directory: string, name?: string) {
      this.uri = name ? `${directory.replace(/\/$/, "")}/${name}` : directory;
    }

    get exists(): boolean {
      return fsMock.writes.has(this.uri);
    }

    write(bytes: Uint8Array): void | Promise<void> {
      fsMock.writes.set(this.uri, bytes);
      return fsMock.pendingWrite ?? undefined;
    }
  }

  return {
    File,
    Paths: {
      cache: "file:///cache",
      document: "file:///document",
    },
  };
});

vi.mock("expo-file-system/legacy", () => ({
  createDownloadResumable: legacyFileSystemMock.createDownloadResumable,
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn().mockResolvedValue(false),
  shareAsync: vi.fn(),
}));

function createRelayOnlyProfile(): HostProfile {
  return createHostProfile([
    {
      id: "relay-1",
      type: "relay",
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pubkey",
    },
  ]);
}

function createMixedProfile(): HostProfile {
  return createHostProfile([
    {
      id: "relay-1",
      type: "relay",
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pubkey",
    },
    {
      id: "direct-1",
      type: "directTcp",
      endpoint: "127.0.0.1:6767",
      useTls: false,
    },
  ]);
}

function createHostProfile(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv-relay",
    label: "Relay",
    lifecycle: {},
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    connections,
  };
}

function createTokenResponse(input?: {
  size?: number | null;
  fileName?: string;
  mimeType?: string;
}) {
  return {
    token: "token",
    fileName: input?.fileName ?? "report.txt",
    mimeType: input?.mimeType ?? "text/plain",
    size: input?.size === undefined ? 3 : input.size,
    error: null,
  };
}

describe("download store", () => {
  beforeEach(() => {
    platformMock.isWeb = false;
    fsMock.writes.clear();
    fsMock.pendingWrite = null;
    legacyFileSystemMock.createDownloadResumable.mockClear();
    useDownloadStore.setState({
      downloads: new Map(),
      activeDownloadId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("downloads through websocket file bytes when no direct download host is available", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse());
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "text/plain",
      size: 3,
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });

    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.status).toBe("complete");
    expect(requestFileDownloadToken).toHaveBeenCalledWith("report.txt");
    expect(requestFileBytes).toHaveBeenCalledWith("report.txt");
    expect(fsMock.writes.get("file:///cache/report.txt")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("uses websocket bytes when the active relay profile also has a direct connection", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse());
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "text/plain",
      size: 3,
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createMixedProfile(),
      activeConnectionId: "relay-1",
      requestFileDownloadToken,
      requestFileBytes,
    });

    expect(requestFileDownloadToken).toHaveBeenCalledWith("report.txt");
    expect(requestFileBytes).toHaveBeenCalledWith("report.txt");
    expect(fsMock.writes.get("file:///cache/report.txt")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("uses the direct token download path when the active connection is direct tcp", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse());
    const requestFileBytes = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createMixedProfile(),
      activeConnectionId: "direct-1",
      requestFileDownloadToken,
      requestFileBytes,
    });

    expect(requestFileDownloadToken).toHaveBeenCalledWith("report.txt");
    expect(requestFileBytes).not.toHaveBeenCalled();
    expect(legacyFileSystemMock.createDownloadResumable).toHaveBeenCalled();
    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("complete");
  });

  it("fails websocket downloads when the returned bytes do not match the advertised size", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(
      createTokenResponse({
        fileName: "archive.bin",
        mimeType: "application/octet-stream",
        size: 10,
      }),
    );
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array(),
      mime: "application/octet-stream",
      size: 10,
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "archive.bin",
      path: "archive.bin",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });

    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("error");
    expect(fsMock.writes.has("file:///cache/archive.bin")).toBe(false);
  });

  it("fails oversized websocket downloads before reading bytes", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(
      createTokenResponse({
        fileName: "large.bin",
        mimeType: "application/octet-stream",
        size: 51 * 1024 * 1024,
      }),
    );
    const requestFileBytes = vi.fn();

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "large.bin",
      path: "large.bin",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });

    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("error");
    expect(requestFileBytes).not.toHaveBeenCalled();
    expect(fsMock.writes.has("file:///cache/large.bin")).toBe(false);
  });

  it("downloads websocket bytes when the token response does not include a size", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse({ size: null }));
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "text/plain",
      size: 3,
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });

    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("complete");
    expect(requestFileBytes).toHaveBeenCalledWith("report.txt");
    expect(fsMock.writes.get("file:///cache/report.txt")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("waits for native websocket byte writes before marking the download complete", async () => {
    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse());
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "text/plain",
      size: 3,
    });
    let resolveWrite!: () => void;
    fsMock.pendingWrite = new Promise((resolve) => {
      resolveWrite = resolve;
    });

    const downloadPromise = useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });
    for (let index = 0; index < 5 && !fsMock.writes.has("file:///cache/report.txt"); index++) {
      await Promise.resolve();
    }
    expect(fsMock.writes.has("file:///cache/report.txt")).toBe(true);

    let downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("downloading");

    resolveWrite();
    await downloadPromise;

    downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("complete");
  });

  it("downloads websocket bytes through a browser blob on web", async () => {
    platformMock.isWeb = true;
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue("blob:paseo-download");
    const revokeObjectURL = vi.fn();
    const OriginalURL = URL;
    const MockURL = class extends OriginalURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    };
    const link = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
      remove: vi.fn(),
    };
    const documentMock = {
      createElement: vi.fn().mockReturnValue(link),
      body: {
        appendChild: vi.fn(),
      },
    };
    vi.stubGlobal("URL", MockURL);
    vi.stubGlobal("document", documentMock);

    const requestFileDownloadToken = vi.fn().mockResolvedValue(createTokenResponse());
    const requestFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "text/plain",
      size: 3,
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv-relay",
      scopeId: "/workspace",
      fileName: "report.txt",
      path: "report.txt",
      daemonProfile: createRelayOnlyProfile(),
      requestFileDownloadToken,
      requestFileBytes,
    });

    const downloads = Array.from(useDownloadStore.getState().downloads.values());
    expect(downloads[0]?.status).toBe("complete");
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(documentMock.createElement).toHaveBeenCalledWith("a");
    expect(documentMock.body.appendChild).toHaveBeenCalledWith(link);
    expect(link.href).toBe("blob:paseo-download");
    expect(link.download).toBe("report.txt");
    expect(link.rel).toBe("noopener");
    expect(link.click).toHaveBeenCalled();
    expect(link.remove).toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59_001);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:paseo-download");
  });
});
