import { create } from "zustand";
import { File as FSFile, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { openExternalUrl } from "@/utils/open-external-url";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

interface DownloadFileBytesResult {
  bytes: Uint8Array;
  mime: string | null;
  size: number;
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  progress?: DownloadProgress;
  startedAt: number;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: {
    serverId: string;
    scopeId: string;
    fileName: string;
    path: string;
    daemonProfile: HostProfile | undefined;
    activeConnectionId?: string | null;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      size: number | null;
      error: string | null;
    }>;
    requestFileBytes?: (path: string) => Promise<DownloadFileBytesResult>;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const MAX_WEBSOCKET_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const BROWSER_DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    daemonProfile,
    activeConnectionId,
    requestFileDownloadToken,
    requestFileBytes,
  }) => {
    const id = generateDownloadId();
    const download: Download = {
      id,
      serverId,
      scopeId,
      fileName,
      status: "downloading",
      startedAt: Date.now(),
    };

    set((state) => ({
      downloads: new Map(state.downloads).set(id, download),
      activeDownloadId: id,
    }));

    try {
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const expectedSize = tokenResponse.size;

      if (!downloadTarget.baseUrl) {
        await downloadViaFileBytes({
          id,
          path,
          fileName: resolvedFileName,
          expectedSize,
          requestFileBytes,
          completeDownload: get().completeDownload,
          updateProgress: get().updateProgress,
        });
        return;
      }

      const downloadUrl = buildDownloadUrl(
        downloadTarget.baseUrl,
        tokenResponse.token,
        isWeb ? downloadTarget.authCredentials : null,
      );

      if (isWeb) {
        triggerBrowserDownload(downloadUrl, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const targetFile = resolveDownloadTargetFile(resolvedFileName);
      const downloadResumable = LegacyFileSystem.createDownloadResumable(
        downloadUrl,
        targetFile.uri,
        downloadTarget.authHeader
          ? { headers: { Authorization: downloadTarget.authHeader } }
          : undefined,
        (data) => {
          const now = Date.now();
          const { totalBytesWritten, totalBytesExpectedToWrite } = data;

          if (totalBytesExpectedToWrite <= 0) {
            return;
          }

          const percent = totalBytesWritten / totalBytesExpectedToWrite;
          const elapsed = (now - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
          const remaining = totalBytesExpectedToWrite - totalBytesWritten;
          const eta = speed > 0 ? remaining / speed : 0;

          get().updateProgress(id, {
            percent,
            bytesWritten: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            speed,
            eta,
          });
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      if (await Sharing.isAvailableAsync()) {
        await shareDownloadedFile({
          uri: result.uri,
          fileName: resolvedFileName,
          mimeType: tokenResponse.mimeType,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      if (isWeb) {
        console.warn("[DownloadStore] Download failed:", message);
        get().failDownload(id, message);
        return;
      }
      get().failDownload(id, message);
    }
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download || download.status !== "downloading") {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, progress });
      return { downloads: updated };
    });
  },

  completeDownload: (id) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "complete" });
      return { downloads: updated };
    });
  },

  failDownload: (id, message) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "error", message });
      return { downloads: updated };
    });
  },

  dismissDownload: (id) => {
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const updated = new Map(state.downloads);
      for (const [id, download] of updated) {
        if (download.status !== "downloading") {
          updated.delete(id);
        }
      }
      let newActiveId: string | null;
      if (!state.activeDownloadId) newActiveId = null;
      else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
      else newActiveId = findMostRecentDownloadId(updated);
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },
}));

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

interface DownloadTarget {
  baseUrl: string | null;
  authHeader: string | null;
  authCredentials: { username: string; password: string } | null;
}

function resolveDaemonDownloadTarget(
  daemon?: HostProfile,
  activeConnectionId?: string | null,
): DownloadTarget {
  const connection = resolveDownloadConnection(daemon, activeConnectionId);
  if (!connection) {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader, authCredentials };
}

function resolveDownloadConnection(daemon?: HostProfile, activeConnectionId?: string | null) {
  if (!daemon) {
    return null;
  }

  if (activeConnectionId) {
    const selectedConnection =
      daemon.connections.find((connection) => connection.id === activeConnectionId) ?? null;
    return selectedConnection?.type === "directTcp" ? selectedConnection : null;
  }

  const preferredConnectionId = daemon.preferredConnectionId;
  if (preferredConnectionId) {
    const preferredConnection =
      daemon.connections.find((connection) => connection.id === preferredConnectionId) ?? null;
    return preferredConnection?.type === "directTcp" ? preferredConnection : null;
  }

  return daemon.connections.find((connection) => connection.type === "directTcp") ?? null;
}

async function downloadViaFileBytes(input: {
  id: string;
  path: string;
  fileName: string;
  expectedSize: number | null;
  requestFileBytes: ((path: string) => Promise<DownloadFileBytesResult>) | undefined;
  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
}): Promise<void> {
  if (!input.requestFileBytes) {
    throw new Error(i18n.t("downloads.hostUnavailable"));
  }
  if (typeof input.expectedSize === "number" && input.expectedSize > MAX_WEBSOCKET_DOWNLOAD_BYTES) {
    throw new Error(
      i18n.t("downloads.websocketTooLarge", {
        size: formatDownloadSize(MAX_WEBSOCKET_DOWNLOAD_BYTES),
      }),
    );
  }

  const file = await input.requestFileBytes(input.path);
  if (file.size > MAX_WEBSOCKET_DOWNLOAD_BYTES) {
    throw new Error(
      i18n.t("downloads.websocketTooLarge", {
        size: formatDownloadSize(MAX_WEBSOCKET_DOWNLOAD_BYTES),
      }),
    );
  }
  if (file.bytes.byteLength !== file.size) {
    throw new Error(i18n.t("downloads.failed"));
  }

  const mimeType = file.mime ?? "application/octet-stream";
  input.updateProgress(input.id, {
    percent: 1,
    bytesWritten: file.bytes.byteLength,
    totalBytes: file.bytes.byteLength,
    speed: 0,
    eta: 0,
  });

  if (isWeb) {
    triggerBrowserBytesDownload(file.bytes, input.fileName, mimeType);
    input.completeDownload(input.id);
    return;
  }

  const targetFile = resolveDownloadTargetFile(input.fileName);
  await Promise.resolve(targetFile.write(file.bytes));
  input.completeDownload(input.id);

  if (await Sharing.isAvailableAsync()) {
    await shareDownloadedFile({
      uri: targetFile.uri,
      fileName: input.fileName,
      mimeType,
    });
  }
}

function buildDownloadUrl(
  baseUrl: string,
  token: string,
  authCredentials: { username: string; password: string } | null,
): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  if (authCredentials) {
    url.username = authCredentials.username;
    url.password = authCredentials.password;
  }
  return url.toString();
}

function triggerBrowserDownload(url: string, fileName: string) {
  if (typeof document === "undefined") {
    if (typeof window !== "undefined") {
      void openExternalUrl(url);
    }
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function triggerBrowserBytesDownload(bytes: Uint8Array, fileName: string, mimeType: string) {
  const blob = new Blob([toBlobPart(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    triggerBrowserDownload(url, fileName);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), BROWSER_DOWNLOAD_URL_REVOKE_DELAY_MS);
  }
}

function toBlobPart(bytes: Uint8Array): BlobPart {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function shareDownloadedFile(input: {
  uri: string;
  fileName: string | null;
  mimeType: string | null;
}): Promise<void> {
  await Sharing.shareAsync(input.uri, {
    mimeType: input.mimeType ?? undefined,
    dialogTitle: input.fileName
      ? i18n.t("downloads.shareFileNamed", { fileName: input.fileName })
      : i18n.t("downloads.shareFile"),
  });
}

function formatDownloadSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetFile = new FSFile(directory, safeName);
  let suffix = 1;

  while (targetFile.exists) {
    targetFile = new FSFile(directory, `${split.base} (${suffix})${split.ext}`);
    suffix += 1;
  }

  return targetFile;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
