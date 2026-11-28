import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
  TunnelEvent,
  TunnelProviderStatus,
  TunnelStability,
  TunnelTarget,
} from "@getpaseo/plugin/server";
import type { TunnelExposure, TunnelProviderInfo } from "@getpaseo/protocol/tunnels";
import type pino from "pino";

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export type TunnelErrorCode =
  | "provider_not_found"
  | "provider_duplicate"
  | "exposure_duplicate"
  | "invalid_target"
  | "open_failed"
  | "open_timeout"
  | "aborted";

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TunnelError";
  }
}

export interface TunnelHandle {
  close(): Promise<void>;
}

export interface RegisteredTunnelProvider {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly description?: string;
  readonly docsUrl?: string;
  status(options?: { signal?: AbortSignal }): Promise<TunnelProviderStatus>;
  open(
    exposureId: string,
    target: TunnelTarget,
    callbacks: {
      onEvent(event: TunnelEvent): void;
      onClosed(error?: string): void;
    },
  ): TunnelHandle;
}

export interface ExposeTunnelInput {
  id?: string;
  providerId: string;
  host: string;
  port: number;
  label?: string;
  slug?: string;
  waitForReady?: boolean;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

export type TunnelManagerEvent =
  | { type: "exposure.changed"; exposure: TunnelExposure }
  | { type: "providers.changed" };

interface ActiveExposure {
  snapshot: TunnelExposure;
  handle: TunnelHandle | null;
  closed: boolean;
  closing: Promise<void> | null;
  lastClosedReason: string | null;
  resolveReady: (exposure: TunnelExposure) => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
}

function cloneExposure(exposure: TunnelExposure): TunnelExposure {
  return {
    ...exposure,
    target: { ...exposure.target },
  };
}

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function isValidTargetHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/\\?#@]/.test(host)) return false;
  if (host.startsWith("[") || host.endsWith("]")) {
    if (!host.startsWith("[") || !host.endsWith("]")) return false;
    return isIP(host.slice(1, -1)) === 6;
  }
  if (isIP(host) !== 0) return true;
  if (host.includes(":")) return false;
  return HOSTNAME_PATTERN.test(host);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TunnelManager {
  private readonly providers = new Map<string, RegisteredTunnelProvider>();
  private readonly exposures = new Map<string, ActiveExposure>();
  private readonly listeners = new Set<(event: TunnelManagerEvent) => void>();
  private readonly logger: pino.Logger | null;
  private readonly now: () => Date;

  constructor(options?: { logger?: pino.Logger; now?: () => Date }) {
    this.logger = options?.logger?.child({ module: "tunnels" }) ?? null;
    this.now = options?.now ?? (() => new Date());
  }

  subscribe(listener: (event: TunnelManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  registerProvider(provider: RegisteredTunnelProvider): void {
    const id = provider.id.trim();
    if (!id) {
      throw new TunnelError("invalid_target", "Tunnel provider ID is required");
    }
    if (this.providers.has(id)) {
      throw new TunnelError("provider_duplicate", `Tunnel provider "${id}" is already registered`);
    }
    this.providers.set(id, { ...provider, id });
    this.emit({ type: "providers.changed" });
  }

  async unregisterProvider(providerId: string): Promise<void> {
    if (!this.providers.delete(providerId)) return;
    const affected = [...this.exposures.values()]
      .filter((entry) => entry.snapshot.providerId === providerId)
      .map((entry) => entry.snapshot.id);
    await Promise.allSettled(affected.map((id) => this.close(id)));
    this.emit({ type: "providers.changed" });
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const owned = [...this.providers.values()]
      .filter((provider) => provider.pluginId === pluginId)
      .map((provider) => provider.id);
    if (owned.length === 0) return;
    for (const id of owned) {
      this.providers.delete(id);
    }
    const ownedSet = new Set(owned);
    const affected = [...this.exposures.values()]
      .filter((entry) => ownedSet.has(entry.snapshot.providerId))
      .map((entry) => entry.snapshot.id);
    await Promise.allSettled(affected.map((id) => this.close(id)));
    this.emit({ type: "providers.changed" });
  }

  async syncPluginProviders(
    pluginId: string,
    nextProviders: readonly RegisteredTunnelProvider[],
  ): Promise<void> {
    const currentOwned = [...this.providers.values()].filter(
      (provider) => provider.pluginId === pluginId,
    );
    const nextIds = new Set(nextProviders.map((provider) => provider.id));
    const removedIds = currentOwned.map((provider) => provider.id).filter((id) => !nextIds.has(id));

    for (const id of removedIds) {
      this.providers.delete(id);
    }
    for (const next of nextProviders) {
      const existing = this.providers.get(next.id);
      if (existing && existing.pluginId !== pluginId) {
        this.logger?.warn(
          { pluginId, providerId: next.id, ownerPluginId: existing.pluginId },
          "Ignoring duplicate tunnel provider ID from another plugin",
        );
        continue;
      }
      this.providers.set(next.id, next);
    }
    if (removedIds.length > 0) {
      const removedSet = new Set(removedIds);
      const affected = [...this.exposures.values()]
        .filter((entry) => removedSet.has(entry.snapshot.providerId))
        .map((entry) => entry.snapshot.id);
      await Promise.allSettled(affected.map((id) => this.close(id)));
    }
    this.emit({ type: "providers.changed" });
  }

  async listProviders(options?: { signal?: AbortSignal }): Promise<TunnelProviderInfo[]> {
    const registered = [...this.providers.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    return Promise.all(
      registered.map(async (provider): Promise<TunnelProviderInfo> => {
        let availability: TunnelProviderStatus;
        try {
          availability = await provider.status({ signal: options?.signal });
        } catch (error) {
          availability = {
            status: "unavailable",
            reason: describeError(error),
          };
        }
        const info: TunnelProviderInfo = {
          id: provider.id,
          pluginId: provider.pluginId,
          label: provider.label,
          availability,
        };
        if (provider.description !== undefined) info.description = provider.description;
        if (provider.docsUrl !== undefined) info.docsUrl = provider.docsUrl;
        return info;
      }),
    );
  }

  listExposures(): TunnelExposure[] {
    return [...this.exposures.values()]
      .map((entry) => cloneExposure(entry.snapshot))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }

  getExposure(exposureId: string): TunnelExposure | null {
    const entry = this.exposures.get(exposureId);
    return entry ? cloneExposure(entry.snapshot) : null;
  }

  async expose(input: ExposeTunnelInput): Promise<TunnelExposure> {
    const providerId = input.providerId.trim();
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new TunnelError("provider_not_found", `Unknown tunnel provider: ${providerId}`);
    }
    const host = input.host.trim();
    if (!isValidTargetHost(host)) {
      throw new TunnelError(
        "invalid_target",
        `Tunnel target host must be a valid hostname or IP address (got "${input.host}")`,
      );
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new TunnelError(
        "invalid_target",
        `Tunnel target port must be an integer between 1 and 65535 (got ${input.port})`,
      );
    }
    const id = input.id !== undefined ? input.id.trim() : `tun_${randomUUID()}`;
    if (!id) {
      throw new TunnelError("invalid_target", "Tunnel exposure ID must not be empty");
    }
    if (this.exposures.has(id)) {
      throw new TunnelError("exposure_duplicate", `Tunnel exposure "${id}" is already active`);
    }
    if (input.signal?.aborted) {
      throw new TunnelError("aborted", "Tunnel exposure request was aborted");
    }

    const timestamp = this.now().toISOString();
    const target: TunnelTarget = {
      id,
      host,
      port: input.port,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    };

    let resolveReady!: (exposure: TunnelExposure) => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<TunnelExposure>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Prevent unhandled rejections if waitForReady is false or callers drop out early.
    void readyPromise.catch(() => undefined);

    const entry: ActiveExposure = {
      snapshot: {
        id,
        providerId: provider.id,
        target: {
          host,
          port: input.port,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
        },
        state: "connecting",
        url: null,
        stability: null,
        detail: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      handle: null,
      closed: false,
      closing: null,
      lastClosedReason: null,
      resolveReady,
      rejectReady,
      readySettled: false,
    };

    this.exposures.set(id, entry);
    this.emit({ type: "exposure.changed", exposure: cloneExposure(entry.snapshot) });

    try {
      entry.handle = provider.open(id, target, {
        onEvent: (event) => this.handleProviderEvent(entry, event),
        onClosed: (error) => this.handleProviderClosed(entry, error),
      });
    } catch (error) {
      const message = describeError(error);
      this.finalizeExposure(entry, { error: message });
      throw new TunnelError("open_failed", message, { cause: error });
    }

    if (input.waitForReady === false) {
      return cloneExposure(entry.snapshot);
    }

    const timeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return await new Promise<TunnelExposure>((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        void this.close(id);
        reject(new TunnelError("aborted", "Tunnel exposure request was aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        void this.close(id);
        reject(
          new TunnelError(
            "open_timeout",
            `Timed out waiting for tunnel provider "${provider.id}" to become ready`,
          ),
        );
      }, timeoutMs);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      readyPromise.then(
        (exposure) => {
          cleanup();
          resolve(exposure);
          return undefined;
        },
        (error) => {
          cleanup();
          reject(error);
          return undefined;
        },
      );
    });
  }

  async close(exposureId: string): Promise<boolean> {
    const entry = this.exposures.get(exposureId);
    if (!entry) return false;
    if (entry.closing) {
      await entry.closing;
      return true;
    }
    const closing = (async () => {
      try {
        await entry.handle?.close();
      } catch (error) {
        this.logger?.warn({ err: error, exposureId }, "Tunnel handle close failed");
      } finally {
        this.finalizeExposure(entry, {});
      }
    })();
    entry.closing = closing;
    await closing;
    return true;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.exposures.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  private handleProviderEvent(entry: ActiveExposure, event: TunnelEvent): void {
    if (entry.closed) return;
    const timestamp = this.now().toISOString();

    if (event.type === "connecting") {
      const detail = event.detail ?? null;
      if (entry.snapshot.state === "connecting" && entry.snapshot.detail === detail) return;
      entry.snapshot = {
        ...entry.snapshot,
        state: "connecting",
        detail,
        updatedAt: timestamp,
      };
      this.emit({ type: "exposure.changed", exposure: cloneExposure(entry.snapshot) });
      return;
    }

    if (event.type === "ready") {
      if (!isHttpUrl(event.url)) {
        const message = `Tunnel provider "${entry.snapshot.providerId}" reported invalid URL: ${event.url}`;
        this.finalizeExposure(entry, { error: message });
        void entry.handle?.close().catch(() => undefined);
        return;
      }
      const stability: TunnelStability | null = event.stability ?? null;
      entry.snapshot = {
        ...entry.snapshot,
        state: "ready",
        url: event.url,
        stability,
        detail: event.detail ?? null,
        error: null,
        updatedAt: timestamp,
      };
      const snapshot = cloneExposure(entry.snapshot);
      this.emit({ type: "exposure.changed", exposure: snapshot });
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.resolveReady(snapshot);
      }
      return;
    }

    if (event.type === "reconnecting") {
      entry.snapshot = {
        ...entry.snapshot,
        state: "reconnecting",
        detail: event.reason ?? null,
        updatedAt: timestamp,
      };
      this.emit({ type: "exposure.changed", exposure: cloneExposure(entry.snapshot) });
      return;
    }

    if (event.type === "error") {
      entry.snapshot = {
        ...entry.snapshot,
        state: "error",
        error: event.message,
        updatedAt: timestamp,
      };
      this.emit({ type: "exposure.changed", exposure: cloneExposure(entry.snapshot) });
      if (event.recoverable !== true && !entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(new TunnelError("open_failed", event.message));
      }
      return;
    }

    if (event.type === "closed") {
      entry.lastClosedReason = event.reason ?? null;
      this.finalizeExposure(entry, { reason: event.reason });
    }
  }

  private handleProviderClosed(entry: ActiveExposure, error?: string): void {
    this.finalizeExposure(entry, { error });
  }

  private finalizeExposure(
    entry: ActiveExposure,
    options: { reason?: string; error?: string },
  ): void {
    if (entry.closed) return;
    entry.closed = true;
    this.exposures.delete(entry.snapshot.id);
    const error = options.error ?? entry.snapshot.error;
    const detail = options.reason ?? entry.lastClosedReason ?? entry.snapshot.detail;
    entry.snapshot = {
      ...entry.snapshot,
      state: "closed",
      detail,
      error,
      updatedAt: this.now().toISOString(),
    };
    this.emit({ type: "exposure.changed", exposure: cloneExposure(entry.snapshot) });
    if (!entry.readySettled) {
      entry.readySettled = true;
      entry.rejectReady(
        new TunnelError("open_failed", error ?? "Tunnel closed before becoming ready"),
      );
    }
  }

  private emit(event: TunnelManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn({ err: error }, "Tunnel manager listener failed");
      }
    }
  }
}
