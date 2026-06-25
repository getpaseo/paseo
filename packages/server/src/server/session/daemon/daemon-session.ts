import type pino from "pino";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getPidLockInfo } from "../../pid-lock.js";
import { generateLocalPairingOffer } from "../../pairing-offer.js";
import {
  collectDaemonDiagnostics,
  type DaemonWebSocketRuntimeDiagnosticSnapshot,
} from "./diagnostics.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";

export interface DaemonRuntimeConfig {
  listen: string | null;
  appBaseUrl?: string;
  relay: {
    enabled: boolean;
    endpoint: string;
    publicEndpoint: string;
    useTls: boolean;
    publicUseTls: boolean;
  } | null;
}

export interface DaemonSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface DaemonSessionOptions {
  host: DaemonSessionHost;
  paseoHome: string;
  serverId: string | undefined;
  daemonVersion: string | undefined;
  daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  listAgents: () => ManagedAgent[];
  listProjects: () => Promise<PersistedProjectRecord[]>;
  listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  listProviderAvailability: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  logger: pino.Logger;
}

/**
 * A client's read surface for the daemon process itself: its runtime status
 * (pid-lock start time, listen address, relay config, provider availability) and
 * a fresh local pairing offer for connecting a new client. Owns the `daemon.*`
 * RPCs. Reaches no state beyond the never-mutated runtime values injected at
 * construction and the outbound channel.
 */
export class DaemonSession {
  private readonly host: DaemonSessionHost;
  private readonly paseoHome: string;
  private readonly serverId: string | undefined;
  private readonly daemonVersion: string | undefined;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly listAgents: () => ManagedAgent[];
  private readonly listProjects: () => Promise<PersistedProjectRecord[]>;
  private readonly listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  private readonly listProviderAvailability: () => Promise<ProviderAvailability[]>;
  private readonly getWebSocketRuntimeMetrics: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  private readonly logger: pino.Logger;

  constructor(options: DaemonSessionOptions) {
    this.host = options.host;
    this.paseoHome = options.paseoHome;
    this.serverId = options.serverId;
    this.daemonVersion = options.daemonVersion;
    this.daemonRuntimeConfig = options.daemonRuntimeConfig;
    this.listAgents = options.listAgents;
    this.listProjects = options.listProjects;
    this.listWorkspaces = options.listWorkspaces;
    this.listProviderAvailability = options.listProviderAvailability;
    this.getWebSocketRuntimeMetrics = options.getWebSocketRuntimeMetrics ?? (() => null);
    this.logger = options.logger;
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_status.request" }>,
  ): Promise<void> {
    try {
      const pidInfo = await getPidLockInfo(this.paseoHome);
      const providers = (await this.listProviderAvailability()).map((p) => ({
        provider: p.provider,
        available: p.available,
        error: p.error ?? null,
      }));
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: pidInfo?.startedAt ?? null,
          listen: this.daemonRuntimeConfig?.listen ?? null,
          relay: this.daemonRuntimeConfig?.relay ?? null,
          providers,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon status request");
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      });
    }
  }

  async handleGetPairingOfferRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_pairing_offer.request" }>,
  ): Promise<void> {
    try {
      const relay = this.daemonRuntimeConfig?.relay;
      const pairing = await generateLocalPairingOffer({
        paseoHome: this.paseoHome,
        relayEnabled: relay?.enabled ?? true,
        relayEndpoint: relay?.endpoint,
        relayPublicEndpoint: relay?.publicEndpoint,
        relayUseTls: relay?.useTls,
        relayPublicUseTls: relay?.publicUseTls,
        appBaseUrl: this.daemonRuntimeConfig?.appBaseUrl,
        includeQr: true,
        logger: this.logger,
      });
      this.host.emit({
        type: "daemon.get_pairing_offer.response",
        payload: {
          requestId: msg.requestId,
          url: pairing.url ?? "",
          qr: pairing.qr ?? null,
          relayEnabled: pairing.relayEnabled,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon pairing offer request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: "daemon.get_pairing_offer.request",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handleDiagnosticsRequest(
    msg: Extract<SessionInboundMessage, { type: "diagnostics.request" }>,
  ): Promise<void> {
    try {
      const diagnostic = await collectDaemonDiagnostics({
        paseoHome: this.paseoHome,
        serverId: this.serverId,
        daemonVersion: this.daemonVersion,
        daemonRuntimeConfig: this.daemonRuntimeConfig,
        listAgents: this.listAgents,
        listProjects: this.listProjects,
        listWorkspaces: this.listWorkspaces,
        listProviderAvailability: this.listProviderAvailability,
        getWebSocketRuntimeMetrics: this.getWebSocketRuntimeMetrics,
        logger: this.logger,
      });
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle diagnostics request");
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic: `Paseo diagnostics\n  Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  }
}
