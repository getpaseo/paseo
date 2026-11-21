import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
} from "@/stores/download-store";
import type {
  LocalFileContents,
  LocalFolder,
  RemoteFolderEntry,
} from "@/file-explorer/copy-folder";
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

function createFileSaver() {
  const savedFiles: DownloadedBytes[] = [];
  return {
    savedFiles,
    save: async (file: DownloadedBytes) => {
      savedFiles.push(file);
      return null;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  reader?: ReturnType<typeof createFileReader>;
  saver?: ReturnType<typeof createFileSaver>;
  fetchFile?: typeof fetch;
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
    fetchFile: input.fetchFile ?? (async () => new Response(FILE_BYTES)),
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
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

  it("fails with the HTTP status when a proxy in front of the host rejects the download", async () => {
    const requests: Array<RequestInit | undefined> = [];
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async (_url, init) => {
        requests.push(init);
        return new Response("<h1>401 Authorization Required</h1>", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Paseo"' },
        });
      },
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.httpFailed", { status: 401 }),
    });
    expect(requests).toEqual([{ credentials: "include", redirect: "error" }]);
  });

  it("fails with a readable message when the download request cannot reach the host", async () => {
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
  });

  it("fails with a readable message when the connection drops while the file is downloading", async () => {
    const saver = createFileSaver();
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new TypeError("network error")),
          }),
        ),
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
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

/** Records every file written below it as `path -> text`. */
function memoryFolder(written: Map<string, string>, prefix = ""): LocalFolder {
  return {
    folder: async (name) => memoryFolder(written, `${prefix}${name}/`),
    writeFile: async (name: string, contents: LocalFileContents) => {
      const bytes =
        contents instanceof Uint8Array ? contents : await new Response(contents).arrayBuffer();
      written.set(`${prefix}${name}`, new TextDecoder().decode(bytes));
    },
  };
}

const SMALL_FILE = new TextEncoder().encode("small");
const LARGE_FILE_SIZE = 2 * 1024 * 1024;
const FOLDER_ENTRIES: RemoteFolderEntry[] = [
  { name: "small.txt", path: "out/small.txt", kind: "file", size: SMALL_FILE.byteLength },
  { name: "large.bin", path: "out/large.bin", kind: "file", size: LARGE_FILE_SIZE },
];

interface FolderStartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  readFile?: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
  fetchFile?: typeof fetch;
}

async function startFolderDownload(input: FolderStartInput) {
  const written = new Map<string, string>();
  const sessionReads: string[] = [];
  const tokenRequests: string[] = [];
  const fetched: string[] = [];
  await useDownloadStore.getState().startFolderDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    folderName: "out",
    path: "out",
    destination: memoryFolder(written),
    includeHidden: true,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    listDirectory: async () => FOLDER_ENTRIES,
    requestFileDownloadToken: async (path) => {
      tokenRequests.push(path);
      return { token: `tok-${path}`, fileName: null, mimeType: null, size: null, error: null };
    },
    readFile:
      input.readFile ??
      (async (path) => {
        sessionReads.push(path);
        const bytes = path === "out/small.txt" ? SMALL_FILE : new Uint8Array(LARGE_FILE_SIZE);
        return { bytes, size: bytes.byteLength };
      }),
    fetchFile:
      input.fetchFile ??
      (async (url) => {
        fetched.push(String(url));
        return new Response("over http");
      }),
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  const download = activeDownloadId ? downloads.get(activeDownloadId) : undefined;
  return { download, written, sessionReads, tokenRequests, fetched };
}

describe("folder downloads", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("reads every file over the session when the active connection is the relay", async () => {
    const result = await startFolderDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
    });

    expect(result.download).toMatchObject({
      fileName: "out",
      status: "complete",
      files: { completed: 2, total: 2 },
    });
    expect(result.download?.cancel).toBeUndefined();
    expect(result.sessionReads).toEqual(["out/small.txt", "out/large.bin"]);
    expect(result.tokenRequests).toEqual([]);
    expect([...result.written.keys()]).toEqual(["out/small.txt", "out/large.bin"]);
  });

  it("downloads every file over HTTP when the active connection is directTcp", async () => {
    const result = await startFolderDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
    });

    expect(result.download).toMatchObject({ status: "complete" });
    expect(result.sessionReads).toEqual([]);
    expect(result.tokenRequests).toEqual(["out/small.txt", "out/large.bin"]);
    expect(result.fetched).toEqual([
      "http://localhost:6767/api/files/download?token=tok-out%2Fsmall.txt",
      "http://localhost:6767/api/files/download?token=tok-out%2Flarge.bin",
    ]);
    expect(result.written).toEqual(
      new Map([
        ["out/small.txt", "over http"],
        ["out/large.bin", "over http"],
      ]),
    );
  });

  it("fails before copying when the direct connection has no usable URL", async () => {
    const unusableConnection: DirectTcpHostConnection = {
      id: "direct:unusable",
      type: "directTcp",
      endpoint: "not a host:port",
    };
    const result = await startFolderDownload({
      profile: profileWith([unusableConnection]),
      activeConnectionId: unusableConnection.id,
    });

    expect(result.download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.hostUnavailable"),
    });
    expect(result.written.size).toBe(0);
    expect(result.sessionReads).toEqual([]);
  });

  it("applies the single-file session cap to each file over the relay", async () => {
    const reads: string[] = [];
    const written = new Map<string, string>();
    await useDownloadStore.getState().startFolderDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      folderName: "out",
      path: "out",
      destination: memoryFolder(written),
      includeHidden: true,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      listDirectory: async () => [
        FOLDER_ENTRIES[0]!,
        {
          name: "huge.bin",
          path: "out/huge.bin",
          kind: "file",
          size: MAX_SESSION_DOWNLOAD_BYTES + 1,
        },
      ],
      requestFileDownloadToken: createTokenRequest().request,
      readFile: async (path) => {
        reads.push(path);
        return { bytes: SMALL_FILE, size: SMALL_FILE.byteLength };
      },
    });
    const { activeDownloadId, downloads } = useDownloadStore.getState();

    expect(downloads.get(activeDownloadId!)).toMatchObject({
      status: "error",
      message: i18n.t("downloads.folderIncomplete", { failed: 1, count: 2 }),
    });
    expect(reads).toEqual(["out/small.txt"]);
    expect([...written.keys()]).toEqual(["out/small.txt"]);
  });

  it("reports the files that could not be downloaded", async () => {
    const result = await startFolderDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async (url) =>
        String(url).includes("large.bin")
          ? new Response("gone", { status: 404 })
          : new Response("over http"),
    });

    expect(result.download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.folderIncomplete", { failed: 1, count: 2 }),
    });
    expect(result.download?.message).toBe("1 of 2 files could not be downloaded");
    expect([...result.written.keys()]).toEqual(["out/small.txt"]);
  });

  it("stops and says so when the download is cancelled", async () => {
    const result = await startFolderDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      readFile: async () => {
        const { activeDownloadId, downloads } = useDownloadStore.getState();
        downloads.get(activeDownloadId!)?.cancel?.();
        return { bytes: SMALL_FILE, size: SMALL_FILE.byteLength };
      },
    });

    expect(result.download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.cancelled"),
    });
    expect(result.download?.cancel).toBeUndefined();
  });
});
