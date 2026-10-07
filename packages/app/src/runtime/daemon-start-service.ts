import { startDesktopDaemon, type DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { connectionFromListen } from "@/types/host-connection";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import {
  discoverStartupLocalDaemons,
  type DiscoveredLocalDaemon,
} from "@/desktop/daemon/discover-local-daemons";

export type DaemonStartResult = { ok: true } | { ok: false; error: string };
export type DaemonStartCondition = boolean | (() => boolean | Promise<boolean>);

export interface StartDaemonIfEnabledInput {
  shouldStart: DaemonStartCondition;
}

type DaemonConnectionStore = Pick<HostRuntimeStore, "getHosts" | "upsertConnectionFromListen">;

export interface DaemonStartServiceDeps {
  store: DaemonConnectionStore;
  startDesktopDaemon?: () => Promise<DesktopDaemonStatus>;
  discoverLocalDaemons?: () => Promise<DiscoveredLocalDaemon[]>;
}

export async function upsertDesktopDaemonConnection(
  store: DaemonConnectionStore,
  daemon: DesktopDaemonStatus,
): Promise<DaemonStartResult> {
  const serverId = daemon.serverId.trim();
  if (!serverId) {
    return { ok: false, error: "Desktop daemon did not return a server id." };
  }
  if (store.getHosts().some((host) => host.serverId === serverId)) {
    return { ok: true };
  }
  const listenAddress = daemon.listen?.trim() ?? "";
  if (!listenAddress) {
    return { ok: false, error: "Desktop daemon did not return a listen address." };
  }
  if (!connectionFromListen(listenAddress)) {
    return {
      ok: false,
      error: `Desktop daemon returned an unsupported listen address: ${listenAddress}`,
    };
  }
  await store.upsertConnectionFromListen({
    listenAddress,
    serverId,
    hostname: daemon.hostname,
  });
  return { ok: true };
}

export class DaemonStartService {
  private readonly store: DaemonConnectionStore;
  private readonly invokeStartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  private readonly discoverLocalDaemons: DaemonStartServiceDeps["discoverLocalDaemons"];
  private pendingLocalConnection: DiscoveredLocalDaemon | null = null;
  private readonly listeners = new Set<() => void>();
  private lastError: string | null = null;
  private inFlightCount = 0;

  constructor(deps: DaemonStartServiceDeps) {
    this.store = deps.store;
    this.invokeStartDesktopDaemon = deps.startDesktopDaemon ?? startDesktopDaemon;
    this.discoverLocalDaemons = deps.discoverLocalDaemons;
  }

  async start(): Promise<DaemonStartResult> {
    return this.startIfEnabled({ shouldStart: true });
  }

  async startIfEnabled(input: StartDaemonIfEnabledInput): Promise<DaemonStartResult> {
    // Settings evaluation is part of startup. Publish the running state before
    // its first await so restored app chrome cannot appear between these phases.
    this.beginRequest();
    try {
      let shouldStart: boolean;
      try {
        shouldStart =
          typeof input.shouldStart === "boolean" ? input.shouldStart : await input.shouldStart();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.fail(`Failed to evaluate desktop daemon settings: ${message}`);
      }

      if (!shouldStart) {
        return { ok: true };
      }

      if (this.discoverLocalDaemons) {
        const existing = await this.discoverLocalDaemons();
        const available = existing.find((daemon) => daemon.serverId && !daemon.passwordRequired);
        if (available?.serverId) {
          // Register a normal connection, including when this host was previously
          // saved through a relay. Never call Desktop's lifecycle manager here.
          await this.store.upsertConnectionFromListen({
            listenAddress: `${available.host}:${available.port}`,
            serverId: available.serverId,
            hostname: available.hostname,
          });
          return { ok: true };
        }
        const requiresPassword = existing.find((daemon) => daemon.passwordRequired);
        if (requiresPassword) {
          // Let the existing connection UI collect credentials instead of starting
          // another daemon at this occupied address. Keep the user's startup setting.
          this.pendingLocalConnection = requiresPassword;
          return { ok: true };
        }
      }

      const daemon = await this.invokeStartDesktopDaemon();
      const result = await upsertDesktopDaemonConnection(this.store, daemon);
      return result.ok ? result : this.fail(result.error);
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.endRequest();
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getPendingLocalConnection(): DiscoveredLocalDaemon | null {
    return this.pendingLocalConnection;
  }

  clearPendingLocalConnection(): void {
    this.pendingLocalConnection = null;
  }

  isRunning(): boolean {
    return this.inFlightCount > 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fail(message: string): DaemonStartResult {
    this.setLastError(message);
    return { ok: false, error: message };
  }

  private setLastError(value: string | null): void {
    if (this.lastError === value) {
      return;
    }
    this.lastError = value;
    this.notify();
  }

  private beginRequest(): void {
    this.pendingLocalConnection = null;
    const becameRunning = this.inFlightCount === 0;
    this.inFlightCount += 1;
    const errorChanged = this.lastError !== null;
    this.lastError = null;
    if (becameRunning || errorChanged) {
      this.notify();
    }
  }

  private endRequest(): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    if (this.inFlightCount === 0) {
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let singletonDaemonStartService: DaemonStartService | null = null;
const DAEMON_START_SERVICE_GLOBAL_KEY = "__paseoDaemonStartService";

type DaemonStartServiceGlobal = typeof globalThis & {
  [DAEMON_START_SERVICE_GLOBAL_KEY]?: DaemonStartService;
};

export function getDaemonStartService(deps: DaemonStartServiceDeps): DaemonStartService {
  if (singletonDaemonStartService) {
    return singletonDaemonStartService;
  }

  const runtimeGlobal = globalThis as DaemonStartServiceGlobal;
  if (runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY]) {
    singletonDaemonStartService = runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] ?? null;
    if (singletonDaemonStartService) {
      return singletonDaemonStartService;
    }
  }

  singletonDaemonStartService = new DaemonStartService({
    ...deps,
    discoverLocalDaemons: deps.discoverLocalDaemons ?? discoverStartupLocalDaemons,
  });
  runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] = singletonDaemonStartService;
  return singletonDaemonStartService;
}
