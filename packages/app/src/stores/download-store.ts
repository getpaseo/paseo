import { create } from "zustand";
import type { DownloadPlatform } from "./download-platform-types";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
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
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      error: string | null;
    }>;
    /**
     * Streams the entry over the WebSocket binary channel. Present only when the host
     * advertises `workspaceFileTransfer`; the caller owns that gate. When absent the
     * store falls back to the HTTP endpoint, which cannot work on a relay connection.
     */
    downloadEntry?: (input: {
      path: string;
      sink: {
        onBegin?: (metadata: { size: number; sizeKnown?: boolean; fileName?: string }) => void;
        onChunk: (chunk: Uint8Array) => void | Promise<void>;
      };
      signal?: AbortSignal;
    }) => Promise<{ fileName: string; mimeType: string; size: number | null }>;
    /** Filesystem and sharing, injected so this store carries no Expo imports. */
    platform: DownloadPlatform;
  }) => Promise<void>;

  /** Aborts an in-flight download, which sends fs.transfer.cancel and stops the daemon. */
  cancelDownload: (id: string) => void;
  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

/**
 * Drives one download over the WebSocket binary channel.
 *
 * Web collects Blob parts and clicks an object URL; native writes each chunk straight to
 * a file handle so a large download never has to fit in memory. Progress repaints at most
 * once a second — the toast used to repaint on every callback.
 */
async function runBinaryChannelDownload({
  path,
  fileName,
  downloadEntry,
  platform,
  signal,
  onProgress,
}: {
  id: string;
  path: string;
  fileName: string;
  downloadEntry: NonNullable<Parameters<DownloadState["startDownload"]>[0]["downloadEntry"]>;
  platform: DownloadPlatform;
  signal?: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  const startedAt = Date.now();
  let receivedBytes = 0;
  let totalBytes = 0;
  let lastRepaintAt = 0;

  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastRepaintAt < 1000) {
      return;
    }
    lastRepaintAt = now;
    const elapsed = (now - startedAt) / 1000;
    const speed = elapsed > 0 ? receivedBytes / elapsed : 0;
    const remaining = totalBytes > 0 ? Math.max(totalBytes - receivedBytes, 0) : 0;
    onProgress({
      percent: totalBytes > 0 ? receivedBytes / totalBytes : 0,
      bytesWritten: receivedBytes,
      totalBytes,
      speed,
      eta: speed > 0 && totalBytes > 0 ? remaining / speed : 0,
    });
  };

  if (platform.isWeb) {
    const parts: Uint8Array[] = [];
    const result = await downloadEntry({
      path,
      signal,
      sink: {
        onBegin: (metadata) => {
          totalBytes = metadata.sizeKnown === false ? 0 : metadata.size;
        },
        onChunk: (chunk) => {
          parts.push(chunk);
          receivedBytes += chunk.byteLength;
          report(false);
        },
      },
    });
    report(true);

    const resolvedFileName = result.fileName || fileName;
    const blob = new Blob(parts as BlobPart[], {
      type: result.mimeType || "application/octet-stream",
    });
    const objectUrl = URL.createObjectURL(blob);
    try {
      platform.deliverToBrowser(objectUrl, resolvedFileName);
    } finally {
      // Revoking synchronously can race the click on some browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
    return;
  }

  // The cache file is named from FileBegin, not from the caller: a folder download is
  // requested as "site" but arrives as "site.zip", and the share sheet hands over this
  // URI as-is, so a file created under the wrong name reaches the OS without its
  // extension. Creation therefore waits until the daemon has said what this is.
  let cacheFile: ReturnType<DownloadPlatform["createCacheFile"]> | null = null;
  let result: { fileName: string; mimeType: string; size: number | null };
  try {
    result = await downloadEntry({
      path,
      signal,
      sink: {
        onBegin: (metadata) => {
          totalBytes = metadata.sizeKnown === false ? 0 : metadata.size;
          cacheFile = platform.createCacheFile(metadata.fileName || fileName);
        },
        onChunk: (chunk) => {
          if (!cacheFile) {
            return;
          }
          cacheFile.write(chunk);
          receivedBytes += chunk.byteLength;
          report(false);
        },
      },
    });
  } catch (error) {
    // Nothing usable was produced, so do not leave a partial file in the cache to be
    // suffixed around by the next attempt.
    const partial = cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null;
    partial?.close();
    cacheFile = null;
    try {
      partial?.remove();
    } catch {
      // Best effort: a cache file we cannot remove must not mask the transfer error.
    }
    throw error;
  } finally {
    (cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null)?.close();
  }
  report(true);

  const savedFile = cacheFile as ReturnType<DownloadPlatform["createCacheFile"]> | null;
  if (savedFile && (await platform.isSharingAvailable())) {
    const resolvedFileName = result.fileName || fileName;
    await platform.share(savedFile.uri, {
      mimeType: result.mimeType || undefined,
      dialogTitle: resolvedFileName
        ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

/**
 * Abort handles for in-flight downloads, keyed by download id. Kept outside the store
 * state: they are not rendered, and putting non-serialisable handles in state invites
 * them being treated as data.
 */
const downloadAbortControllers = new Map<string, AbortController>();

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
    daemonProfile,
    requestFileDownloadToken,
    downloadEntry,
    platform,
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
      if (downloadEntry) {
        const controller = new AbortController();
        downloadAbortControllers.set(id, controller);
        try {
          await runBinaryChannelDownload({
            id,
            path,
            fileName,
            downloadEntry,
            platform,
            signal: controller.signal,
            onProgress: (progress) => get().updateProgress(id, progress),
          });
        } finally {
          downloadAbortControllers.delete(id);
        }
        get().completeDownload(id);
        return;
      }

      // COMPAT(httpFileDownload): added in v0.6.2, remove after 2027-02-01 once the daemon
      // floor ships fs.entry.download. This path needs a second origin the relay does not
      // expose, which is the root cause of the #543 issue cluster.
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile);
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadUrl = buildDownloadUrl(
        downloadTarget.baseUrl,
        tokenResponse.token,
        platform.isWeb ? downloadTarget.authCredentials : null,
      );

      if (platform.isWeb) {
        platform.deliverToBrowser(downloadUrl, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const result = await platform.downloadOverHttp({
        url: downloadUrl,
        fileName: resolvedFileName,
        authHeader: downloadTarget.authHeader,
        onProgress: (written, expected) => {
          if (expected <= 0) {
            return;
          }
          const elapsed = (Date.now() - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? written / elapsed : 0;
          get().updateProgress(id, {
            percent: written / expected,
            bytesWritten: written,
            totalBytes: expected,
            speed,
            eta: speed > 0 ? (expected - written) / speed : 0,
          });
        },
      });
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      if (await platform.isSharingAvailable()) {
        await platform.share(result.uri, {
          mimeType: tokenResponse.mimeType ?? undefined,
          dialogTitle: resolvedFileName
            ? i18n.t("downloads.shareFileNamed", { fileName: resolvedFileName })
            : i18n.t("downloads.shareFile"),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      if (platform.isWeb) {
        console.warn("[DownloadStore] Download failed:", message);
        get().failDownload(id, message);
        return;
      }
      get().failDownload(id, message);
    }
  },

  cancelDownload: (id) => {
    downloadAbortControllers.get(id)?.abort();
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

function resolveDaemonDownloadTarget(daemon?: HostProfile): DownloadTarget {
  const connection = daemon?.connections.find((conn) => conn.type === "directTcp") ?? null;
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
