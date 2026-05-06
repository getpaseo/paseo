import { startDesktopDaemon, type DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { connectionFromListen } from "@/types/host-connection";
import type { HostRuntimeStore } from "@/runtime/host-runtime";

export type DaemonStartResult = { ok: true } | { ok: false; error: string };

export interface DaemonStartServiceDeps {
  store: Pick<HostRuntimeStore, "upsertConnectionFromListen">;
  startDesktopDaemon?: () => Promise<DesktopDaemonStatus>;
}

export class DaemonStartService {
  private readonly store: Pick<HostRuntimeStore, "upsertConnectionFromListen">;
  private readonly invokeStartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  private readonly listeners = new Set<() => void>();
  private lastError: string | null = null;
  private inFlightCount = 0;

  constructor(deps: DaemonStartServiceDeps) {
    this.store = deps.store;
    this.invokeStartDesktopDaemon = deps.startDesktopDaemon ?? startDesktopDaemon;
  }

  async start(): Promise<DaemonStartResult> {
    this.beginRequest();
    try {
      const daemon = await this.invokeStartDesktopDaemon();
      const listenAddress = daemon.listen?.trim() ?? "";
      const serverId = daemon.serverId.trim();
      if (!listenAddress) {
        return this.fail("Desktop daemon did not return a listen address.");
      }
      if (!serverId) {
        return this.fail("Desktop daemon did not return a server id.");
      }
      if (!connectionFromListen(listenAddress)) {
        return this.fail(`Desktop daemon returned an unsupported listen address: ${listenAddress}`);
      }
      await this.store.upsertConnectionFromListen({
        listenAddress,
        serverId,
        hostname: daemon.hostname,
      });
      return { ok: true };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.endRequest();
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  recordError(message: string): void {
    this.setLastError(message);
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

  singletonDaemonStartService = new DaemonStartService(deps);
  runtimeGlobal[DAEMON_START_SERVICE_GLOBAL_KEY] = singletonDaemonStartService;
  return singletonDaemonStartService;
}
