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
    activeConnectionId: string | null;
    supportsRelayFileDownloads: boolean;
    requestFileDownloadToken: (path: string) => Promise<DownloadTokenResult>;
    requestFileBytes: (path: string) => Promise<RelayFileResult>;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

interface DownloadTokenResult {
  token: string | null;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  error: string | null;
}

interface RelayFileResult {
  bytes: Uint8Array;
  mime: string;
  size: number;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// The existing binary read API assembles the file in memory on both peers.
// Keep relay fallback bounded until the protocol grows a streaming download sink.
export const MAX_RELAY_DOWNLOAD_BYTES = 32 * 1024 * 1024;

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
    supportsRelayFileDownloads,
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
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
      if (!downloadTarget.baseUrl) {
        const bytesWritten = await downloadViaRelay({
          path,
          fileName: resolvedFileName,
          tokenResponse,
          supportsRelayFileDownloads,
          requestFileBytes,
        });
        get().updateProgress(id, {
          percent: 1,
          bytesWritten,
          totalBytes: bytesWritten,
          speed: 0,
          eta: 0,
        });
        get().completeDownload(id);
        return;
      }

      await downloadViaDirect({
        target: { ...downloadTarget, baseUrl: downloadTarget.baseUrl },
        token: tokenResponse.token,
        fileName: resolvedFileName,
        mimeType: tokenResponse.mimeType,
        onProgress: (progress) => get().updateProgress(id, progress),
      });
      get().completeDownload(id);
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
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTarget {
  const activeConnection =
    daemon?.connections.find((connection) => connection.id === activeConnectionId) ?? null;
  const connection = activeConnection?.type === "directTcp" ? activeConnection : null;
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

async function downloadViaRelay(input: {
  path: string;
  fileName: string;
  tokenResponse: DownloadTokenResult;
  supportsRelayFileDownloads: boolean;
  requestFileBytes: (path: string) => Promise<RelayFileResult>;
}): Promise<number> {
  if (!input.supportsRelayFileDownloads) {
    throw new Error(i18n.t("downloads.hostUnavailable"));
  }
  assertRelayDownloadSize(input.tokenResponse.size);

  const relayFile = await input.requestFileBytes(input.path);
  assertRelayDownloadSize(relayFile.bytes.byteLength);
  const mimeType = input.tokenResponse.mimeType ?? relayFile.mime;

  if (isWeb) {
    triggerBrowserByteDownload(relayFile.bytes, mimeType, input.fileName);
    return relayFile.bytes.byteLength;
  }

  const targetFile = resolveDownloadTargetFile(input.fileName);
  targetFile.write(relayFile.bytes);
  await shareDownloadedFile(targetFile.uri, input.fileName, mimeType);
  return relayFile.bytes.byteLength;
}

async function downloadViaDirect(input: {
  target: DownloadTarget & { baseUrl: string };
  token: string;
  fileName: string;
  mimeType: string | null;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  const downloadUrl = buildDownloadUrl(
    input.target.baseUrl,
    input.token,
    isWeb ? input.target.authCredentials : null,
  );
  if (isWeb) {
    triggerBrowserDownload(downloadUrl, input.fileName);
    return;
  }

  const downloadStartTime = Date.now();
  const targetFile = resolveDownloadTargetFile(input.fileName);
  const downloadResumable = LegacyFileSystem.createDownloadResumable(
    downloadUrl,
    targetFile.uri,
    input.target.authHeader ? { headers: { Authorization: input.target.authHeader } } : undefined,
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite <= 0) return;
      const elapsed = (Date.now() - downloadStartTime) / 1000;
      const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
      input.onProgress({
        percent: totalBytesWritten / totalBytesExpectedToWrite,
        bytesWritten: totalBytesWritten,
        totalBytes: totalBytesExpectedToWrite,
        speed,
        eta: speed > 0 ? (totalBytesExpectedToWrite - totalBytesWritten) / speed : 0,
      });
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) {
    throw new Error(i18n.t("downloads.cancelled"));
  }
  await shareDownloadedFile(result.uri, input.fileName, input.mimeType);
}

function assertRelayDownloadSize(size: number | null): void {
  if (size !== null && size > MAX_RELAY_DOWNLOAD_BYTES) {
    throw new Error(
      i18n.t("downloads.relayFileTooLarge", {
        size: formatFileSize(MAX_RELAY_DOWNLOAD_BYTES),
      }),
    );
  }
}

async function shareDownloadedFile(
  uri: string,
  fileName: string,
  mimeType: string | null,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) return;
  await Sharing.shareAsync(uri, {
    mimeType: mimeType ?? undefined,
    dialogTitle: fileName
      ? i18n.t("downloads.shareFileNamed", { fileName })
      : i18n.t("downloads.shareFile"),
  });
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

function triggerBrowserByteDownload(bytes: Uint8Array, mimeType: string, fileName: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerBrowserDownload(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

function formatFileSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
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
