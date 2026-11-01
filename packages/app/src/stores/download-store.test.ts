import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import type { DownloadedFile } from "@/downloads/share-file";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
} from "@/stores/download-store";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/données été.bin";
const FILE_NAME = "données été.bin";
const MIME_TYPE = "application/octet-stream";

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

// The #3753 shape: the relay hostname stored as a directTcp entry that nothing can reach.
const staleTcpConnection: DirectTcpHostConnection = {
  id: "direct:relay.paseo.sh:443",
  type: "directTcp",
  endpoint: "relay.paseo.sh:443",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

function profileWith(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv_remote",
    label: "Remote",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createTokenRequest(size: number | null = FILE_BYTES.byteLength) {
  const requested: string[] = [];
  return {
    requested,
    request: async (path: string) => {
      requested.push(path);
      return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size, error: null };
    },
  };
}

function createFileReader(read: () => Promise<{ bytes: Uint8Array; size: number }>) {
  const requested: string[] = [];
  return {
    requested,
    read: async (path: string) => {
      requested.push(path);
      return read();
    },
  };
}

function createFileSaver(uri: string | null = null) {
  const savedFiles: DownloadedBytes[] = [];
  return {
    savedFiles,
    save: async (file: DownloadedBytes) => {
      savedFiles.push(file);
      return uri;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  reader?: ReturnType<typeof createFileReader>;
  saver?: ReturnType<typeof createFileSaver>;
  exporter?: (file: DownloadedFile) => Promise<boolean>;
}

async function startDownload(input: StartInput): Promise<Download | undefined> {
  const token = input.token ?? createTokenRequest();
  const reader =
    input.reader ??
    createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }));
  const saver = input.saver ?? createFileSaver();
  await useDownloadStore.getState().startDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    requestFileDownloadToken: token.request,
    readFile: reader.read,
    saveFile: saver.save,
    exportFile: input.exporter,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("waits for the destination write before completing a native download", async () => {
    const exporting = Promise.withResolvers<void>();
    const destinationWrite = Promise.withResolvers<boolean>();
    const exportedFiles: DownloadedFile[] = [];
    const pendingDownload = startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      saver: createFileSaver("file:///cache/report.bin"),
      exporter: async (file) => {
        exportedFiles.push(file);
        exporting.resolve();
        return destinationWrite.promise;
      },
    });

    await exporting.promise;
    const { activeDownloadId, downloads } = useDownloadStore.getState();
    expect(downloads.get(activeDownloadId!)).toMatchObject({ status: "exporting" });
    expect(exportedFiles).toEqual([
      { uri: "file:///cache/report.bin", fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);

    useDownloadStore.getState().dismissAllCompleted();
    expect(useDownloadStore.getState().downloads.get(activeDownloadId!)).toMatchObject({
      status: "exporting",
    });

    destinationWrite.resolve(true);
    expect(await pendingDownload).toMatchObject({ status: "complete" });
  });

  it("dismisses a cancelled export without reporting success or failure", async () => {
    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      saver: createFileSaver("file:///cache/report.bin"),
      exporter: async () => false,
    });

    expect(download).toBeUndefined();
    expect(useDownloadStore.getState().downloads.size).toBe(0);
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
  });

  it("reports a destination write failure instead of completing the download", async () => {
    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      saver: createFileSaver("file:///cache/report.bin"),
      exporter: async () => {
        throw new Error("Destination storage is full");
      },
    });

    expect(download).toMatchObject({
      status: "error",
      message: "Destination storage is full",
    });
  });

  it("downloads over the session when the active connection is the relay", async () => {
    const token = createTokenRequest();
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "complete" });
    expect(token.requested).toEqual([FILE_PATH]);
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("bounds the session read even when the token reports a smaller file", async () => {
    const readRequests: Array<{ path: string; maxBytes: number }> = [];
    const saver = createFileSaver();
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(1).request,
      readFile: async (path: string, maxBytes: number) => {
        readRequests.push({ path, maxBytes });
        return { bytes: FILE_BYTES, size: FILE_BYTES.byteLength };
      },
      saveFile: saver.save,
    });
    expect(readRequests).toEqual([{ path: FILE_PATH, maxBytes: MAX_SESSION_DOWNLOAD_BYTES }]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("ignores a directTcp entry that is not the active connection", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([staleTcpConnection, relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toHaveLength(1);
  });

  it("keeps the HTTP token download when the active connection is directTcp", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: localTcpConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails the download and saves nothing when the session read fails", async () => {
    const reader = createFileReader(async () => {
      throw new Error("Connection lost");
    });
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(saver.savedFiles).toEqual([]);
  });

  it("refuses a file over the session size limit before reading it", async () => {
    const token = createTokenRequest(MAX_SESSION_DOWNLOAD_BYTES + 1);
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("composer.errors.fileTooLarge", { fileName: FILE_NAME, size: "64 MB" }),
    });
    expect(download?.message).toContain("64 MB");
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails instead of saving an empty file when the daemon returns no content", async () => {
    const reader = createFileReader(async () => ({ bytes: new Uint8Array(), size: 6 }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: "File transfer incomplete: expected 6 bytes, received 0.",
    });
    expect(saver.savedFiles).toEqual([]);
  });
});
