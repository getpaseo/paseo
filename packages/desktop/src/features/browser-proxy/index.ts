import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, session as electronSession, type WebContents } from "electron";
import log from "electron-log/main";
import {
  getHostBrowserProxyPartition,
  isHostBrowserProxyPartition,
  PASEO_BROWSER_HOST_PARTITION_PREFIX,
} from "./partition.js";
import {
  createBrowserProxyManager,
  type BrowserProxyManager,
  type BrowserProxyStatus,
  type BrowserProxyStatusSnapshot,
} from "./internal/proxy-manager.js";
import type { BrowserProxyTarget } from "./internal/tunnel-transport.js";

export {
  createBrowserProxyManager,
  getHostBrowserProxyPartition,
  isHostBrowserProxyPartition,
  PASEO_BROWSER_HOST_PARTITION_PREFIX,
  type BrowserProxyManager,
  type BrowserProxyStatus,
  type BrowserProxyStatusSnapshot,
  type BrowserProxyTarget,
};

const TICKET_REQUEST_TIMEOUT_MS = 10_000;
export const BROWSER_PROXY_STATUS_EVENT = "paseo:event:browser-proxy-status";
export const BROWSER_PROXY_TICKET_REQUEST_EVENT = "paseo:event:browser-proxy-ticket-request";

interface PendingTicketRequest {
  readonly serverId: string;
  readonly expectedResponders: number;
  failures: number;
  lastError: string | null;
  resolve: (ticket: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDirectTcpTarget(raw: Record<string, unknown>): BrowserProxyTarget | null {
  const endpoint = readNonEmptyString(raw.endpoint);
  if (!endpoint) return null;
  return {
    type: "directTcp",
    endpoint,
    ...(typeof raw.useTls === "boolean" ? { useTls: raw.useTls } : {}),
  };
}

function parseRemoteSshTarget(raw: Record<string, unknown>): BrowserProxyTarget | null {
  const host = readNonEmptyString(raw.host);
  if (!host) return null;
  return {
    type: "remoteSsh",
    host,
    ...(typeof raw.sshPort === "number" ? { sshPort: raw.sshPort } : {}),
    ...(typeof raw.daemonPort === "number" ? { daemonPort: raw.daemonPort } : {}),
  };
}

function parseRelayTarget(raw: Record<string, unknown>): BrowserProxyTarget | null {
  const serverId = readNonEmptyString(raw.serverId);
  const relayEndpoint = readNonEmptyString(raw.relayEndpoint);
  const daemonPublicKeyB64 = readNonEmptyString(raw.daemonPublicKeyB64);
  if (!serverId || !relayEndpoint || !daemonPublicKeyB64) return null;
  return {
    type: "relay",
    serverId,
    relayEndpoint,
    ...(typeof raw.useTls === "boolean" ? { useTls: raw.useTls } : {}),
    daemonPublicKeyB64,
    ...(raw.minimumSecurityMode === "protected" ? { minimumSecurityMode: "protected" } : {}),
  };
}

export function parseBrowserProxyTarget(raw: unknown): BrowserProxyTarget | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }
  if (raw.type === "directTcp") return parseDirectTcpTarget(raw);
  if (raw.type === "remoteSsh") return parseRemoteSshTarget(raw);
  if (raw.type === "relay") return parseRelayTarget(raw);
  return null;
}

export function createElectronBrowserProxyController(): {
  manager: BrowserProxyManager;
  registerIpc: () => void;
  dispose: () => Promise<void>;
} {
  const pendingTicketRequests = new Map<string, PendingTicketRequest>();

  const requestTicketFromRenderer = (serverId: string): Promise<string> => {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    if (windows.length === 0) {
      return Promise.reject(new Error("No desktop window is available to mint a tunnel ticket"));
    }

    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingTicketRequests.get(requestId);
        if (!pending) return;
        pendingTicketRequests.delete(requestId);
        reject(new Error(pending.lastError ?? "Timed out requesting network tunnel ticket"));
      }, TICKET_REQUEST_TIMEOUT_MS);
      timer.unref?.();

      pendingTicketRequests.set(requestId, {
        serverId,
        expectedResponders: windows.length,
        failures: 0,
        lastError: null,
        resolve,
        reject,
        timer,
      });

      for (const win of windows) {
        try {
          win.webContents.send(BROWSER_PROXY_TICKET_REQUEST_EVENT, { requestId, serverId });
        } catch {
          // Ignore destroyed windows
        }
      }
    });
  };

  const broadcastStatus = (status: BrowserProxyStatusSnapshot): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(BROWSER_PROXY_STATUS_EVENT, status);
      } catch {
        // Ignore destroyed renderer
      }
    }
  };

  const manager = createBrowserProxyManager({
    requestTicket: requestTicketFromRenderer,
    getSessionForPartition: (partition) => electronSession.fromPartition(partition),
    onStatusChange: broadcastStatus,
    log: {
      info: (message, details) => log.info(message, details),
      warn: (message, details) => log.warn(message, details),
    },
  });

  const registerIpc = (): void => {
    ipcMain.handle("paseo:browser-proxy:ensure-host", async (_event, rawInput: unknown) => {
      if (!isRecord(rawInput) || typeof rawInput.serverId !== "string") {
        throw new Error("Invalid browser proxy ensure input");
      }
      const target = parseBrowserProxyTarget(rawInput.target);
      if (!target) {
        throw new Error("Invalid browser proxy target");
      }
      return await manager.ensureHostProxy({
        serverId: rawInput.serverId,
        target,
        forceReconnect: rawInput.forceReconnect === true,
      });
    });

    ipcMain.handle("paseo:browser-proxy:update-target", (_event, rawInput: unknown) => {
      if (!isRecord(rawInput) || typeof rawInput.serverId !== "string") {
        return;
      }
      const target = parseBrowserProxyTarget(rawInput.target);
      if (!target) {
        return;
      }
      manager.updateHostProxyTarget({ serverId: rawInput.serverId, target });
    });

    ipcMain.handle("paseo:browser-proxy:get-status", (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || serverId.trim().length === 0) {
        return null;
      }
      return manager.getHostProxyStatus(serverId);
    });

    ipcMain.handle("paseo:browser-proxy:release-host", async (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || serverId.trim().length === 0) {
        return;
      }
      await manager.releaseHostProxy(serverId);
    });

    ipcMain.handle("paseo:browser-proxy:deliver-ticket", (_event, rawInput: unknown) => {
      if (!isRecord(rawInput) || typeof rawInput.requestId !== "string") {
        return;
      }
      const pending = pendingTicketRequests.get(rawInput.requestId);
      if (!pending) {
        return;
      }
      if (typeof rawInput.ticket === "string" && rawInput.ticket.trim().length > 0) {
        clearTimeout(pending.timer);
        pendingTicketRequests.delete(rawInput.requestId);
        pending.resolve(rawInput.ticket.trim());
        return;
      }
      pending.failures += 1;
      if (typeof rawInput.error === "string" && rawInput.error.trim().length > 0) {
        pending.lastError = rawInput.error.trim();
      }
      if (pending.failures >= pending.expectedResponders) {
        clearTimeout(pending.timer);
        pendingTicketRequests.delete(rawInput.requestId);
        pending.reject(new Error(pending.lastError ?? "Unable to mint network tunnel ticket"));
      }
    });
  };

  const dispose = async (): Promise<void> => {
    for (const [requestId, pending] of pendingTicketRequests) {
      clearTimeout(pending.timer);
      pendingTicketRequests.delete(requestId);
      pending.reject(new Error("Browser proxy shutting down"));
    }
    await manager.disposeAll();
  };

  return { manager, registerIpc, dispose };
}

export function applyProxiedWebContentsPolicy(
  contents: Pick<WebContents, "session" | "setWebRTCIPHandlingPolicy">,
  manager: Pick<BrowserProxyManager, "isProxiedSession">,
): void {
  if (manager.isProxiedSession(contents.session)) {
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  }
}
