import { create } from "zustand";
import * as LegacyFileSystem from "expo-file-system/legacy";
import {
  FileDownloadError,
  type FileDownloadProgress,
  type FileReadResult,
} from "@getpaseo/client/internal/daemon-client";
import type { DirectTcpHostConnection } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import type { DownloadTransport } from "@/utils/download-transport";
import { computeDownloadProgress, type DownloadProgress } from "@/utils/download-progress";
import {
  resolveDownloadTargetFile,
  shareDownloadedFile,
  triggerBrowserDownload,
  type SaveDownloadedFile,
} from "@/utils/download-files";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";
import { DownloadUserError } from "@/stores/download-user-error";

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

interface FileDownloadToken {
  token: string | null;
  fileName: string | null;
  mimeType: string | null;
  error: string | null;
}

export type RequestFileDownloadToken = (path: string) => Promise<FileDownloadToken>;

const BYTES_PER_MEGABYTE = 1024 * 1024;

// Session downloads hold the whole file in memory until it is saved, so large files could crash the app.
export const MAX_SESSION_DOWNLOAD_BYTES = 128 * BYTES_PER_MEGABYTE;

export interface SessionDownloadOptions {
  maxBytes: number;
  onProgress: (progress: FileDownloadProgress) => void;
}

export type DownloadFileOverSession = (
  path: string,
  options: SessionDownloadOptions,
) => Promise<FileReadResult>;

interface StartDownloadParams {
  serverId: string;
  scopeId: string;
  fileName: string;
  path: string;
  transport: DownloadTransport;
  requestFileDownloadToken: RequestFileDownloadToken;
  downloadFileOverSession: DownloadFileOverSession;
  saveDownloadedFile: SaveDownloadedFile;
}

interface DownloadCallbacks {
  onProgress: (progress: DownloadProgress) => void;
  onComplete: () => void;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: StartDownloadParams) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    transport,
    requestFileDownloadToken,
    downloadFileOverSession,
    saveDownloadedFile,
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

    const callbacks: DownloadCallbacks = {
      onProgress: (progress) => get().updateProgress(id, progress),
      onComplete: () => get().completeDownload(id),
    };

    try {
      if (transport.kind === "http") {
        await runHttpDownload({
          connection: transport.connection,
          fileName,
          path,
          requestFileDownloadToken,
          callbacks,
        });
      } else {
        await runSessionDownload({
          fileName,
          path,
          downloadFileOverSession,
          saveDownloadedFile,
          callbacks,
        });
      }
    } catch (error) {
      console.warn("[DownloadStore] Download failed:", error);
      get().failDownload(id, toUserFacingDownloadMessage(error));
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

function toUserFacingDownloadMessage(error: unknown): string {
  return error instanceof DownloadUserError ? error.message : i18n.t("downloads.failed");
}

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

interface HttpDownloadInput {
  connection: DirectTcpHostConnection;
  fileName: string;
  path: string;
  requestFileDownloadToken: RequestFileDownloadToken;
  callbacks: DownloadCallbacks;
}

async function runHttpDownload(input: HttpDownloadInput): Promise<void> {
  const { connection, fileName, path, requestFileDownloadToken, callbacks } = input;
  const tokenResponse = await requestFileDownloadToken(path);
  if (tokenResponse.error || !tokenResponse.token) {
    if (tokenResponse.error) {
      console.warn("[DownloadStore] Download token request failed:", tokenResponse.error);
    }
    throw new DownloadUserError(i18n.t("downloads.requestTokenFailed"));
  }

  const downloadTarget = resolveDaemonDownloadTarget(connection);
  if (!downloadTarget.baseUrl) {
    throw new DownloadUserError(i18n.t("downloads.hostUnavailable"));
  }

  const resolvedFileName = tokenResponse.fileName ?? fileName;
  const downloadUrl = buildDownloadUrl(
    downloadTarget.baseUrl,
    tokenResponse.token,
    isWeb ? downloadTarget.authCredentials : null,
  );

  if (isWeb) {
    triggerBrowserDownload(downloadUrl, resolvedFileName);
    callbacks.onComplete();
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
      const progress = computeDownloadProgress({
        receivedBytes: data.totalBytesWritten,
        totalBytes: data.totalBytesExpectedToWrite,
        startedAt: downloadStartTime,
        now: Date.now(),
      });
      if (progress) {
        callbacks.onProgress(progress);
      }
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) {
    throw new DownloadUserError(i18n.t("downloads.cancelled"));
  }

  callbacks.onComplete();
  await shareDownloadedFile({
    uri: result.uri,
    mimeType: tokenResponse.mimeType,
    fileName: resolvedFileName,
  });
}

interface SessionDownloadInput {
  fileName: string;
  path: string;
  downloadFileOverSession: DownloadFileOverSession;
  saveDownloadedFile: SaveDownloadedFile;
  callbacks: DownloadCallbacks;
}

async function runSessionDownload(input: SessionDownloadInput): Promise<void> {
  const { fileName, path, downloadFileOverSession, saveDownloadedFile, callbacks } = input;
  const downloadStartTime = Date.now();
  const file = await downloadFileOverSession(path, {
    maxBytes: MAX_SESSION_DOWNLOAD_BYTES,
    onProgress: ({ receivedBytes, totalBytes }) => {
      const progress = computeDownloadProgress({
        receivedBytes,
        totalBytes,
        startedAt: downloadStartTime,
        now: Date.now(),
      });
      if (progress) {
        callbacks.onProgress(progress);
      }
    },
  }).catch((error: unknown) => {
    throw localizeSessionDownloadError(error);
  });

  await saveDownloadedFile(
    { bytes: file.bytes, mimeType: file.mime, fileName },
    { onSaved: callbacks.onComplete },
  );
}

function localizeSessionDownloadError(error: unknown): unknown {
  if (!(error instanceof FileDownloadError)) {
    return error;
  }
  switch (error.code) {
    case "too_large":
      return new DownloadUserError(
        i18n.t("downloads.tooLarge", {
          limit: `${MAX_SESSION_DOWNLOAD_BYTES / BYTES_PER_MEGABYTE} MB`,
        }),
        { cause: error },
      );
    case "incomplete":
      return new DownloadUserError(i18n.t("downloads.incomplete"), { cause: error });
    case "content_unavailable":
      return new DownloadUserError(i18n.t("downloads.contentUnavailable"), {
        cause: error,
      });
  }
}

function resolveDaemonDownloadTarget(connection: DirectTcpHostConnection): DownloadTarget {
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
