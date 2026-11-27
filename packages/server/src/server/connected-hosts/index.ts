export { DaemonLinkEndpoint, VirtualHostSocket } from "./link.js";
export { ConnectedHostSession } from "./session.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createHostClient,
  createHostChannelTransport,
  createHostTransportFactory,
  parseHostTarget,
  HostTransportBudget,
} from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  HostSummarySchema,
  HostAddSchema,
  HostUpdateSchema,
  HostReverseOfferSchema,
  type HostDirectory,
  type HostSummary,
  type HostAdd,
  type HostUpdate,
} from "@getpaseo/protocol/hosts";
import type { DaemonPermission, WSHelloMessage } from "@getpaseo/protocol/messages";
import { webSocketProxyAgent } from "../network/index.js";

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly serverId?: string,
  ) {
    super(message);
  }
}
const SavedSchema = HostSummarySchema.omit({
  direction: true,
  reverseEnabled: true,
  reverseStatus: true,
}).extend({
  connection: z.string(),
  incomingToken: HostAddSchema.shape.incomingToken,
  reverseOffer: HostReverseOfferSchema.optional(),
});
type Saved = z.infer<typeof SavedSchema>;
export interface HostActor {
  sourceId: string;
  manageSources: boolean;
  permissions?: readonly DaemonPermission[];
}
export type ConnectReverseHost = (input: {
  client: DaemonClient;
  serverId: string;
  token: string;
  permissions: readonly DaemonPermission[];
  signal: AbortSignal;
  connected(): void;
}) => Promise<void>;
interface ReverseRun {
  controller: AbortController;
  status: NonNullable<HostSummary["reverseStatus"]>;
}
interface IncomingCarrier {
  close(): void;
}
interface Live {
  client: DaemonClient;
  accepted: boolean;
  stop(): void;
}
interface Route {
  registrationId: string;
  close(code?: string, message?: string): void;
}

/** Daemon-owned configuration, identity pinning, retry and routed session lifetime. */
export class ConnectedHosts {
  private readonly budget = new HostTransportBudget();
  private rows: Saved[] = [];
  private readonly live = new Map<string, Live>();
  private readonly incoming = new Map<string, IncomingCarrier>();
  private readonly reverse = new Map<string, ReverseRun>();
  private readonly routes = new Set<Route>();
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private closed = false;
  constructor(
    private readonly home: string,
    private readonly self: HostDirectory["self"],
    private readonly connectReverse?: ConnectReverseHost,
  ) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async readRows(file: string): Promise<Saved[]> {
    try {
      return z.array(SavedSchema).parse(JSON.parse(await readFile(join(this.home, file), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Cannot read saved connected hosts", { cause: error });
      return [];
    }
  }
  private async load(): Promise<void> {
    const rows = await Promise.all([
      this.readRows("hosts.json"),
      this.readRows("incoming-hosts.json"),
    ]);
    this.rows = rows.flat();
    if (this.closed) return;
    for (const row of this.rows) {
      row.status = this.initialStatus(row);
      row.nextRetryAt = null;
      this.start(row);
    }
  }
  async list(): Promise<HostDirectory> {
    await this.ready;
    return {
      self: { ...this.self },
      hosts: this.rows.map((row) => this.summary(row)),
    };
  }
  observe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => this.listeners.delete(changed);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private async persist(rows: Saved[], changedRow: Saved): Promise<void> {
    // Older daemons read hosts.json and would try dialing a passive entry.
    const incoming = Boolean(changedRow.incomingToken);
    const file = incoming ? "incoming-hosts.json" : "hosts.json";
    const savedRows = rows.filter((row) => Boolean(row.incomingToken) === incoming);
    await mkdir(this.home, { recursive: true });
    const temp = join(this.home, `.hosts-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(savedRows), { mode: 0o600 });
      await rename(temp, join(this.home, file));
    } finally {
      await rm(temp, { force: true });
    }
  }
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready;
      if (this.closed) throw new HostError("host_offline", "Daemon is stopping");
      return run();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private summary(row: Saved): HostSummary {
    const {
      connection: _connection,
      incomingToken: _incomingToken,
      reverseOffer,
      ...summary
    } = row;
    return structuredClone({
      ...summary,
      ...(row.incomingToken ? { direction: "incoming" as const } : {}),
      ...(reverseOffer ? { reverseEnabled: true, reverseStatus: this.reverseStatus(row) } : {}),
    });
  }
  private describeRegistration(
    input: HostAdd,
    actor: HostActor,
    incomingPeer: string | null,
  ): string {
    if (!incomingPeer && input.incomingToken === undefined)
      return parseHostTarget(input.connection).description;
    if (!actor.manageSources)
      throw new HostError("permission_denied", "Only an access manager can approve reverse access");
    if (!incomingPeer || !input.incomingToken)
      throw new HostError(
        "invalid_connection",
        "An incoming registration requires a peer and token",
      );
    if (incomingPeer === this.self.serverId)
      throw new HostError("self_host", "Cannot approve this daemon as an incoming peer");
    return `Incoming link from ${incomingPeer}`;
  }
  add(input: HostAdd, actor: HostActor): Promise<HostSummary> {
    return this.mutate(async () => {
      input = HostAddSchema.parse(input);
      const incomingPeer = incomingPeerId(input.connection);
      const description = this.describeRegistration(input, actor, incomingPeer);
      const source = { id: actor.sourceId, key: input.sourceKey ?? randomUUID() };
      const existing = this.rows.find(
        (row) => row.source.id === source.id && row.source.key === source.key,
      );
      if (existing) {
        if (
          existing.connection === input.connection &&
          existing.incomingToken === input.incomingToken &&
          existing.label === (input.label ?? null) &&
          JSON.stringify(Object.entries(existing.metadata).sort()) ===
            JSON.stringify(Object.entries(input.metadata ?? {}).sort())
        )
          return this.summary(existing);
        throw new HostError(
          "source_conflict",
          "This source key already exists. Update its registration explicitly.",
        );
      }
      if (incomingPeer && this.rows.some((row) => this.peerId(row) === incomingPeer))
        throw new HostError("duplicate_host", "Another registration already owns this daemon");
      if (this.rows.length >= 128)
        throw new HostError("resource_limit", "Remove a host before adding another (limit 128)");
      const row: Saved = {
        registrationId: `hst_${randomUUID()}`,
        serverId: null,
        connection: input.connection,
        incomingToken: input.incomingToken,
        label: input.label ?? null,
        metadata: input.metadata ?? {},
        source,
        enabled: true,
        status: incomingPeer ? "offline" : "connecting",
        targetDescription: description,
        lastOnlineAt: null,
        nextRetryAt: null,
        error: null,
      };
      await this.persist([...this.rows, row], row);
      this.rows.push(row);
      this.start(row);
      this.changed();
      return this.summary(row);
    });
  }
  private validateReverseUpdate(previous: Saved, patch: HostUpdate, actor: HostActor): void {
    if (patch.reverseOffer === undefined && !(previous.incomingToken && patch.enabled)) return;
    if (!actor.manageSources)
      throw new HostError("permission_denied", "Only an access manager can approve reverse access");
    const offer = patch.reverseOffer;
    if (!offer) return;
    if (
      previous.incomingToken ||
      !previous.serverId ||
      !previous.lastOnlineAt ||
      patch.connection !== undefined
    )
      throw new HostError(
        "invalid_connection",
        "Verify an outbound host before granting reverse access",
      );
    const live = this.live.get(previous.registrationId);
    if (
      live?.accepted &&
      live.client.getLastServerInfoMessage()?.features?.hostBidirectionalLinks !== true
    )
      throw new HostError(
        "unsupported_capability",
        "Update the destination daemon to use reverse access",
      );
    if (offer.permissions.some((permission) => !actor.permissions?.includes(permission)))
      throw new HostError("permission_denied", "Cannot offer permissions the caller does not have");
  }
  private validateUpdate(previous: Saved, patch: HostUpdate, actor: HostActor): void {
    if (previous.incomingToken && (patch.connection !== undefined || patch.replaceIdentity))
      throw new HostError("invalid_connection", "Remove and reapprove to replace an incoming peer");
    if (
      (patch.connection !== undefined || patch.metadata !== undefined || patch.replaceIdentity) &&
      actor.sourceId !== previous.source.id &&
      !actor.manageSources
    )
      throw new HostError(
        "permission_denied",
        "Only the source or access manager can replace its connection and metadata",
      );
    if (patch.replaceIdentity && patch.connection === undefined)
      throw new HostError(
        "invalid_connection",
        "Identity replacement requires a replacement connection",
      );
    this.validateReverseUpdate(previous, patch, actor);
  }
  update(id: string, patch: HostUpdate, actor: HostActor): Promise<HostSummary> {
    return this.mutate(async () => {
      patch = HostUpdateSchema.parse(patch);
      const previous = this.require(id);
      this.validateUpdate(previous, patch, actor);
      const row: Saved = {
        ...previous,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      };
      if (patch.reverseOffer !== undefined) row.reverseOffer = patch.reverseOffer ?? undefined;
      if (patch.connection !== undefined) {
        row.reverseOffer = undefined;
        row.connection = patch.connection;
        row.targetDescription = parseHostTarget(patch.connection).description;
      }
      if (patch.replaceIdentity) row.serverId = null;
      const restart = patch.connection !== undefined || patch.enabled !== undefined;
      if (restart) {
        row.status = this.initialStatus(row);
        row.error = null;
        row.nextRetryAt = null;
      }
      const rows = this.rows.map((entry) => (entry === previous ? row : entry));
      await this.persist(rows, row);
      if (restart) this.stop(id, row.enabled ? "host_offline" : "host_disabled");
      else if (patch.reverseOffer !== undefined) this.stopReverse(id);
      Object.assign(previous, row);
      if (restart) this.start(previous);
      else if (patch.reverseOffer !== undefined) this.startReverse(previous);
      this.changed();
      return this.summary(previous);
    });
  }
  remove(id: string, actor: HostActor): Promise<void> {
    return this.mutate(async () => {
      const row = this.require(id);
      if (actor.sourceId !== row.source.id && !actor.manageSources)
        throw new HostError(
          "permission_denied",
          "Only the source or access manager can remove this host. Disable it to stop access.",
        );
      const rows = this.rows.filter((entry) => entry !== row);
      await this.persist(rows, row);
      this.stop(id, "host_unknown");
      this.rows = rows;
      this.changed();
    });
  }
  private require(id: string): Saved {
    const row = this.rows.find((entry) => entry.registrationId === id);
    if (!row) throw new HostError("host_unknown", "Unknown host registration");
    return row;
  }
  private initialStatus(row: Saved): HostSummary["status"] {
    if (!row.enabled) return "disabled";
    return row.incomingToken ? "offline" : "connecting";
  }
  private peerId(row: Saved): string | null {
    return row.serverId ?? incomingPeerId(row.connection);
  }
  private closeRoutes(id: string, code = "host_offline"): void {
    for (const route of this.routes)
      if (route.registrationId === id)
        route.close(code, "Host access was disabled, replaced or removed");
  }
  private stop(id: string, code = "host_offline"): void {
    this.stopReverse(id);
    this.closeRoutes(id, code);
    const incoming = this.incoming.get(id);
    this.incoming.delete(id);
    incoming?.close();
    const live = this.live.get(id);
    this.live.delete(id);
    live?.stop();
  }
  private reverseStatus(row: Saved): NonNullable<HostSummary["reverseStatus"]> {
    const run = this.reverse.get(row.registrationId);
    if (run) return run.status;
    const live = this.live.get(row.registrationId);
    return live?.accepted &&
      live.client.getLastServerInfoMessage()?.features?.hostBidirectionalLinks !== true
      ? "error"
      : "offline";
  }
  private stopReverse(id: string): void {
    const run = this.reverse.get(id);
    this.reverse.delete(id);
    run?.controller.abort();
  }
  private startReverse(row: Saved): void {
    const connect = this.connectReverse;
    const live = this.live.get(row.registrationId);
    const serverId = row.serverId;
    const offer = row.reverseOffer;
    if (
      !connect ||
      !live?.accepted ||
      !serverId ||
      !offer ||
      live.client.getLastServerInfoMessage()?.features?.hostBidirectionalLinks !== true ||
      this.reverse.has(row.registrationId)
    )
      return;

    const controller = new AbortController();
    const { signal } = controller;
    const run: ReverseRun = { controller, status: "connecting" };
    this.reverse.set(row.registrationId, run);
    const update = (status: ReverseRun["status"]) => {
      if (signal.aborted || status === run.status) return;
      run.status = status;
      this.changed();
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    signal.addEventListener("abort", () => clearTimeout(retry), { once: true });
    const attempt = async () => {
      if (signal.aborted) return;
      update("connecting");
      try {
        await connect({
          client: live.client,
          serverId,
          token: offer.token,
          permissions: offer.permissions,
          signal,
          connected: () => {
            attempts = 0;
            update("online");
          },
        });
        update("offline");
      } catch {
        update("error");
      }
      if (signal.aborted) return;
      retry = setTimeout(() => void attempt(), acceptanceRetryDelayMs(attempts++));
      retry.unref();
    };
    void attempt();
  }
  async acceptReverse(
    peerServerId: string,
    close: () => void,
  ): Promise<{
    token: string;
    attach(client: DaemonClient): Promise<void>;
    detach(): void;
  }> {
    return this.mutate(async () => {
      const row = this.rows.find(
        (entry) => entry.incomingToken && incomingPeerId(entry.connection) === peerServerId,
      );
      if (!row?.enabled || !row.incomingToken)
        throw new HostError("permission_denied", "Reverse host access has not been approved");
      if (this.rows.find((entry) => this.peerId(entry) === peerServerId) !== row)
        throw new HostError("duplicate_host", "Another registration already owns this daemon");
      const id = row.registrationId;
      if (this.incoming.has(id))
        throw new HostError("duplicate_host", "A reverse carrier already owns this daemon");
      const carrier: IncomingCarrier = { close };
      let detached = false;
      let client: DaemonClient | undefined;
      let unsubscribe: (() => void) | undefined;
      const detach = () => {
        if (detached) return;
        detached = true;
        unsubscribe?.();
        if (this.incoming.get(id) !== carrier) return;
        this.incoming.delete(id);
        this.live.delete(id);
        this.closeRoutes(id);
        if (row.status === "online") {
          row.status = "offline";
          this.changed();
        }
        close();
        if (client) void client.close().catch(() => {});
      };
      return {
        token: row.incomingToken,
        detach,
        attach: (connected) =>
          this.mutate(async () => {
            if (detached || !row.enabled || !this.rows.includes(row))
              throw new HostError("host_offline", "Incoming host approval changed");
            if (
              this.incoming.has(id) ||
              this.rows.find((entry) => this.peerId(entry) === peerServerId) !== row
            )
              throw new HostError(
                "duplicate_host",
                "Another carrier or registration already owns this daemon",
              );
            const info = connected.getLastServerInfoMessage();
            if (!connected.isConnected || !info || info.serverId !== peerServerId)
              throw new HostError(
                "server_id_mismatch",
                "Reverse link presented an unexpected daemon identity",
              );
            if (!info.features?.connectedHosts || !info.features.hostMultiplexing)
              throw new HostError("unsupported_capability", "Update the incoming daemon");

            const next = {
              ...row,
              serverId: peerServerId,
              status: "online" as const,
              lastOnlineAt: new Date().toISOString(),
            };
            await this.persist(
              this.rows.map((entry) => (entry === row ? next : entry)),
              row,
            );
            if (detached || !connected.isConnected)
              throw new HostError("host_offline", "Incoming host closed during setup");
            this.incoming.set(id, carrier);
            client = connected;
            this.live.set(id, {
              client,
              accepted: true,
              stop: () => void connected.close().catch(() => {}),
            });
            Object.assign(row, next);
            unsubscribe = connected.subscribeConnectionStatus((status) => {
              if (status.status !== "connected") detach();
            });
            this.changed();
          }),
      };
    });
  }
  private start(
    row: Saved,
    resume?: { failures: number; transports: DaemonTransportFactory },
  ): void {
    if (!row.enabled || row.incomingToken || this.closed) return;
    const transports =
      resume?.transports ??
      createHostTransportFactory(row.connection, this.budget, {
        webSocketAgent: webSocketProxyAgent,
      });
    let stopped = false;
    let attempts = resume?.failures ?? 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const client = createHostClient(row.connection, {
      clientId: `host-link-${this.self.serverId}-${row.registrationId}`,
      connectTimeoutMs: 10000,
      transportFactory: transports,
    });
    const live: Live = {
      client,
      accepted: false,
      stop: () => {
        stopped = true;
        clearTimeout(retry);
        void client.close();
      },
    };
    this.live.set(row.registrationId, live);
    const accept = async () => {
      try {
        const info = client.getLastServerInfoMessage();
        if (!info) throw new HostError("host_offline", "No daemon identity received");
        if (row.serverId && info.serverId !== row.serverId)
          throw new HostError(
            "server_id_mismatch",
            "Daemon identity changed. Verify the destination and explicitly replace its identity.",
          );
        if (!row.serverId)
          await this.mutate(async () => {
            if (stopped) return;
            const discovered = { ...row, serverId: info.serverId };
            await this.persist(
              this.rows.map((entry) => (entry === row ? discovered : entry)),
              row,
            );
            row.serverId = info.serverId;
          });
        if (info.serverId === this.self.serverId)
          throw new HostError(
            "self_host",
            "This connection reaches this daemon. Remove it or replace the connection.",
          );
        if (this.rows.find((entry) => this.peerId(entry) === info.serverId) !== row)
          throw new HostError(
            "duplicate_host",
            "Another registration already owns this daemon. Remove the duplicate registration.",
          );
        if (info.features?.connectedHosts !== true || info.features?.hostMultiplexing !== true)
          throw new HostError(
            "unsupported_capability",
            "Update the destination daemon to use connected hosts; retrying automatically.",
          );
        // Pin and persist under the same writer as management to prevent discovery races.
        await this.mutate(async () => {
          if (stopped) return;
          if (this.rows.find((entry) => this.peerId(entry) === info.serverId) !== row)
            throw new HostError("duplicate_host", "Another registration already owns this daemon");
          const next = {
            ...row,
            serverId: info.serverId,
            status: "online" as const,
            lastOnlineAt: new Date().toISOString(),
            error: null,
            nextRetryAt: null,
          };
          await this.persist(
            this.rows.map((entry) => (entry === row ? next : entry)),
            row,
          );
          if (stopped || client.getLastServerInfoMessage() !== info || !client.isConnected) return;
          Object.assign(row, next);
          live.accepted = true;
          attempts = 0;
          this.startReverse(row);
          this.changed();
        });
      } catch (error) {
        if (stopped) return;
        row.error = connectionFailure(error, client.authFailureReason !== null) ?? {
          code: "host_offline",
          message: "Host connection failed",
        };
        if (terminalFailures.has(row.error.code)) {
          row.status = "error";
          row.nextRetryAt = null;
        } else {
          stopped = true;
          retry = this.scheduleAcceptanceRetry(row, attempts, transports);
        }
        this.changed();
        await client.close();
      }
    };
    client.subscribeConnectionStatus((state) => {
      if (stopped || row.status === "error") return;
      live.accepted = false;
      if (state.status === "connected") {
        void accept();
        return;
      }
      this.stopReverse(row.registrationId);
      this.closeRoutes(row.registrationId);
      row.status = state.status === "connecting" ? "connecting" : "offline";
      row.nextRetryAt = state.status === "disconnected" ? (state.nextRetryAt ?? null) : null;
      if (state.status === "disconnected")
        row.error = connectionFailure(
          Object.assign(new Error("Check the SSH configuration and daemon credentials"), {
            code: state.failureCode,
          }),
          client.authFailureReason !== null,
        ) ?? {
          code: "host_offline",
          message: "Cannot reach host. Check the connection; retrying automatically.",
        };
      else if (row.error?.code !== "unsupported_capability") row.error = null;
      if (row.error?.code === "authentication_failed") {
        row.status = "error";
        row.nextRetryAt = null;
        client.setReconnectEnabled(false);
        void client.close();
      }
      this.changed();
    });
    void client.connect().catch(() => {});
  }
  private scheduleAcceptanceRetry(
    row: Saved,
    failures: number,
    transports: DaemonTransportFactory,
  ): ReturnType<typeof setTimeout> {
    const delay = acceptanceRetryDelayMs(failures);
    row.status = "offline";
    row.nextRetryAt = new Date(Date.now() + delay).toISOString();
    const retry = setTimeout(() => this.start(row, { failures: failures + 1, transports }), delay);
    retry.unref();
    return retry;
  }
  async openRoute(input: {
    serverId: string;
    scopeId: string;
    sourceId: string;
    originSessionId: string;
    permissions: readonly DaemonPermission[];
    signal: AbortSignal;
    frame(data: string | Uint8Array): void | Promise<void>;
    ended(code: string, message: string): void;
  }): Promise<{ send(data: string | Uint8Array): void; close(): void }> {
    await this.ready;
    const row = this.rows.find((entry) => entry.serverId === input.serverId);
    if (!row) throw new HostError("host_unknown", `Unknown host ${input.serverId}`, input.serverId);
    if (!row.enabled)
      throw new HostError(
        "host_disabled",
        `Enable host ${input.serverId} before using it`,
        input.serverId,
      );
    if (row.status !== "online")
      throw new HostError(
        row.error?.code ?? "host_offline",
        row.error?.message ?? `Host ${input.serverId} is offline`,
        input.serverId,
      );
    if (this.routes.size >= 128) throw new HostError("resource_limit", "Too many routed sessions");
    const live = this.live.get(row.registrationId);
    const client = live?.client;
    if (!live?.accepted || !client?.isConnected)
      throw new HostError("host_offline", "Host is offline", input.serverId);
    const transport = createHostChannelTransport(
      client,
      input.serverId,
      randomUUID(),
      null,
      true,
    )({ url: "ws://host-link/ws" });
    let closed = false;
    let verified = false;
    let helloSent = false;
    const timer = setTimeout(() => route.close("host_offline", "Host handshake timed out"), 15000);
    timer.unref();
    const route: Route = {
      registrationId: row.registrationId,
      close: (code = "host_offline", message = `Host ${input.serverId} disconnected`) => {
        if (closed) return;
        closed = true;
        input.signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        this.routes.delete(route);
        try {
          transport.close();
        } finally {
          failed(new HostError(code, message, input.serverId));
          input.ended(code, message);
        }
      },
    };
    this.routes.add(route);
    const abort = () =>
      route.close("host_offline", "Origin session closed or its authority changed");
    input.signal.addEventListener("abort", abort, { once: true });
    let opened!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      opened = resolve;
      failed = reject;
    });
    if (input.signal.aborted) {
      route.close();
    }
    transport.onOpen(opened);
    transport.onError((error) => {
      const authenticationFailed =
        error instanceof Error && "code" in error && error.code === "authentication_failed";
      const code = authenticationFailed ? "authentication_failed" : "host_offline";
      const message = authenticationFailed
        ? "Host authentication failed. Check the SSH configuration and daemon credentials."
        : "Host transport failed";
      failed(new HostError(code, message, input.serverId));
      route.close(code, message);
    });
    transport.onClose(() => {
      failed(new HostError("host_offline", "Host transport closed"));
      route.close();
    });
    transport.onMessage((data, binary) => {
      if (closed) return;
      if (!verified) {
        if (binary) {
          route.close();
          return;
        }
        try {
          const envelope = JSON.parse(String(data));
          if (envelope.type === "hello.rejected") {
            route.close("authentication_failed", "Replace the host credentials");
            return;
          }
          const info =
            envelope.type === "session" && envelope.message.type === "status"
              ? envelope.message.payload
              : null;
          if (info?.status !== "server_info") return;
          if (info.serverId !== row.serverId) {
            route.close(
              "server_id_mismatch",
              "Host identity changed; explicit replacement required",
            );
            return;
          }
          if (info.features?.connectedHosts !== true) {
            route.close("unsupported_capability", "Update the destination daemon");
            return;
          }
          verified = true;
          clearTimeout(timer);
        } catch {
          route.close();
          return;
        }
      }
      return input.frame(binary ? (data as Uint8Array) : String(data));
    });
    await ready;
    if (closed) throw new HostError("host_offline", "Host closed during connection");
    return {
      close: () => route.close(),
      send: (data) => {
        const binary = typeof data !== "string";
        if (closed) throw new HostError("host_offline", "Host is offline");
        if (!helloSent) {
          if (binary) throw new HostError("invalid_message", "Expected hello");
          const hello = JSON.parse(data as string) as WSHelloMessage;
          if (hello.type !== "hello") throw new HostError("invalid_message", "Expected hello");
          const clientId = `route-${createHash("sha256")
            .update(
              JSON.stringify([
                this.self.serverId,
                input.sourceId,
                input.originSessionId,
                input.scopeId,
              ]),
            )
            .digest("hex")}`;
          transport.send(
            JSON.stringify({
              ...hello,
              clientId,
              routed: true,
              producer: { serverId: this.self.serverId, sourceId: input.sourceId },
              sessionPermissions: input.permissions,
              auth: undefined,
            }),
          );
          helloSent = true;
          return;
        }
        if (!verified) throw new HostError("host_offline", "Host identity has not been verified");
        const rejectWrite = () =>
          route.close("resource_limit", "Host buffer limit reached or transport unavailable");
        try {
          const write = transport.send(data);
          if (write) void write.catch(rejectWrite);
        } catch {
          rejectWrite();
        }
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.ready;
    await this.queue;
    for (const id of new Set([...this.live.keys(), ...this.incoming.keys()])) this.stop(id);
    for (const route of this.routes) route.close();
    this.listeners.clear();
  }
}

function incomingPeerId(connection: string): string | null {
  return /^reverse:\/\/([A-Za-z0-9_-]{1,256})$/.exec(connection)?.[1] ?? null;
}

const ACCEPTANCE_RETRY_BASE_MS = 1500;
const ACCEPTANCE_RETRY_MAX_MS = 30_000;

function acceptanceRetryDelayMs(failures: number): number {
  return Math.min(ACCEPTANCE_RETRY_BASE_MS * 2 ** failures, ACCEPTANCE_RETRY_MAX_MS);
}

const terminalFailures = new Set([
  "server_id_mismatch",
  "self_host",
  "duplicate_host",
  "authentication_failed",
]);

function connectionFailure(error: unknown, authenticationFailed: boolean): HostSummary["error"] {
  if (error instanceof HostError) return { code: error.code, message: error.message };
  if (error instanceof Error && "code" in error && error.code === "authentication_failed")
    return { code: "authentication_failed", message: error.message };
  if (authenticationFailed)
    return {
      code: "authentication_failed",
      message: "Host rejected the credentials. Replace the connection credentials.",
    };
  return null;
}
