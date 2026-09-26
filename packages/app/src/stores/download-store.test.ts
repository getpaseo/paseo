import { beforeEach, describe, expect, it } from "vitest";
import {
  FileDownloadError,
  type FileDownloadErrorCode,
  type FileReadResult,
} from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadFileOverSession,
} from "@/stores/download-store";
import { DownloadUserError } from "@/stores/download-user-error";
import {
  createFakeDownloadedFileSaver,
  type FakeDownloadedFileSaver,
} from "@/stores/test-utils/fake-save-downloaded-file";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/데이터.bin";
const FILE_NAME = "데이터.bin";

function fileReadResult(bytes: Uint8Array): FileReadResult {
  return {
    bytes,
    mime: "application/octet-stream",
    size: bytes.byteLength,
    path: FILE_PATH,
    kind: "binary",
    modifiedAt: "2026-05-02T00:00:00.000Z",
  };
}

function rejectTokenRequest(): Promise<never> {
  return Promise.reject(new Error("The session transport must not request an HTTP token."));
}

async function streamWholeFile(
  _path: string,
  { onProgress }: Parameters<DownloadFileOverSession>[1],
): Promise<FileReadResult> {
  onProgress({ receivedBytes: FILE_BYTES.byteLength / 2, totalBytes: FILE_BYTES.byteLength });
  onProgress({ receivedBytes: FILE_BYTES.byteLength, totalBytes: FILE_BYTES.byteLength });
  return fileReadResult(FILE_BYTES);
}

interface SessionDownloadInput {
  downloadFileOverSession: DownloadFileOverSession;
  saver: FakeDownloadedFileSaver;
}

async function startSessionDownload(input: SessionDownloadInput): Promise<Download | undefined> {
  await useDownloadStore.getState().startDownload({
    serverId: "srv_relay_only",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    transport: { kind: "session" },
    requestFileDownloadToken: rejectTokenRequest,
    downloadFileOverSession: input.downloadFileOverSession,
    saveDownloadedFile: input.saver.save,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store session transport", () => {
  let saver: FakeDownloadedFileSaver;

  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
    saver = createFakeDownloadedFileSaver();
  });

  it("streams the file over the session and saves the exact bytes", async () => {
    const requests: Array<{ path: string; maxBytes: number }> = [];
    const download = await startSessionDownload({
      downloadFileOverSession: (path, options) => {
        requests.push({ path, maxBytes: options.maxBytes });
        return streamWholeFile(path, options);
      },
      saver,
    });

    expect(requests).toEqual([{ path: FILE_PATH, maxBytes: MAX_SESSION_DOWNLOAD_BYTES }]);
    expect(download).toMatchObject({
      serverId: "srv_relay_only",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      status: "complete",
      progress: {
        percent: 1,
        bytesWritten: FILE_BYTES.byteLength,
        totalBytes: FILE_BYTES.byteLength,
      },
    });
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, mimeType: "application/octet-stream", fileName: FILE_NAME },
    ]);
  });

  it("shows the generic localized failure for an untyped session error and saves nothing", async () => {
    const download = await startSessionDownload({
      downloadFileOverSession: async () => {
        throw new Error("Daemon client closed");
      },
      saver,
    });

    expect(download).toMatchObject({
      fileName: FILE_NAME,
      status: "error",
      message: i18n.t("downloads.failed"),
    });
    expect(download?.message).not.toContain("Daemon client closed");
    expect(saver.savedFiles).toEqual([]);
  });

  it("shows the message of a user-facing download error as is", async () => {
    const userMessage = i18n.t("workspace.terminal.hostDisconnected");
    const download = await startSessionDownload({
      downloadFileOverSession: async () => {
        throw new DownloadUserError(userMessage);
      },
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "error", message: userMessage });
    expect(saver.savedFiles).toEqual([]);
  });

  const typedFailures: Array<{
    code: FileDownloadErrorCode;
    clientMessage: string;
    expectedMessage: () => string;
  }> = [
    {
      code: "too_large",
      clientMessage: "File is too large to display",
      expectedMessage: () => i18n.t("downloads.tooLarge", { limit: "128 MB" }),
    },
    {
      code: "incomplete",
      clientMessage: "File transfer incomplete: expected 10 bytes, received 6.",
      expectedMessage: () => i18n.t("downloads.incomplete"),
    },
    {
      code: "content_unavailable",
      clientMessage: "File content unavailable for download.",
      expectedMessage: () => i18n.t("downloads.contentUnavailable"),
    },
  ];

  it.each(typedFailures)(
    "shows the localized message for a $code session failure",
    async ({ code, clientMessage, expectedMessage }) => {
      const download = await startSessionDownload({
        downloadFileOverSession: async () => {
          throw new FileDownloadError(clientMessage, code);
        },
        saver,
      });

      const message = expectedMessage();
      expect(message).not.toBe(clientMessage);
      expect(message).not.toMatch(/^downloads\./);
      expect(download).toMatchObject({ fileName: FILE_NAME, status: "error", message });
      expect(saver.savedFiles).toEqual([]);
    },
  );

  it("names the session size limit in the too-large message", async () => {
    const download = await startSessionDownload({
      downloadFileOverSession: async () => {
        throw new FileDownloadError("File is too large to display", "too_large");
      },
      saver,
    });

    expect(download?.message).toContain("128 MB");
  });

  it("shows the generic localized failure when the transfer succeeds but saving fails", async () => {
    saver.failNextSave(new Error("No download directory available."));

    const download = await startSessionDownload({
      downloadFileOverSession: streamWholeFile,
      saver,
    });

    expect(download).toMatchObject({
      fileName: FILE_NAME,
      status: "error",
      message: i18n.t("downloads.failed"),
    });
    expect(download?.message).not.toContain("No download directory available.");
    expect(saver.savedFiles).toEqual([]);
  });
});
