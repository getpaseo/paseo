import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import type { WebSocketLike } from "../websocket-server.js";
import {
  isDaemonPermission,
  parseDaemonPermissions,
  permissionsForLegacyHubScopes,
  type DaemonPermission,
} from "../authorization/index.js";
import type { HubExecutionAgents } from "./daemon-executions.js";
import type {
  HubRelationshipRemote,
  HubSocketConnection,
  HubSocketEvents,
} from "./relationship-remote.js";
import { HubEnrollmentRejectedError } from "./relationship-remote.js";
import { BoundedExponentialHubRetryPolicy } from "./relationship-retry.js";

const FILE_NAME = "hub-relationship.json";
const HubOriginSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    try {
      normalizeHubUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid Hub URL",
      });
    }
  });

const DaemonPermissionsSchema = z
  .array(z.string())
  .superRefine((permissions, context) => {
    for (const permission of permissions) {
      if (!isDaemonPermission(permission)) {
        context.addIssue({ code: "custom", message: `Invalid daemon permission: ${permission}` });
      }
    }
  })
  .transform(parseDaemonPermissions);
const RelationshipSchema = z.object({
  daemonId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  hubOrigin: HubOriginSchema,
  createdAt: z.string(),
  permissions: DaemonPermissionsSchema,
});
const SanitizedRelationshipSchema = RelationshipSchema.omit({ idempotencyKey: true });
const CredentialSchema = z.object({ secret: z.string().min(1) });
const TransportSchema = z.object({
  kind: z.literal("direct_websocket"),
  webSocketUrl: z
    .string()
    .url()
    .refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol))
    .refine((value) => new URL(value).hash === ""),
});
const PendingSchema = z.object({
  version: z.literal(2),
  state: z.literal("pending"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  enrollment: z.object({ token: z.string().min(1) }),
  identity: z.object({ serverId: z.string().min(1), daemonPublicKey: z.string().min(1) }),
});
const ActiveSchema = z.object({
  version: z.literal(2),
  state: z.literal("active"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  transport: TransportSchema,
});
const DisconnectingSchema = z.object({
  version: z.literal(2),
  state: z.literal("disconnecting"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  transport: TransportSchema.optional(),
});
const RevokedSchema = z.object({
  version: z.literal(2),
  state: z.literal("revoked"),
  relationship: SanitizedRelationshipSchema,
  transport: TransportSchema.optional(),
  reason: z.string().optional(),
});
const CurrentRecordSchema = z
  .discriminatedUnion("state", [PendingSchema, ActiveSchema, DisconnectingSchema, RevokedSchema])
  .superRefine((record, context) => {
    if (!("transport" in record) || !record.transport) return;
    const hub = new URL(record.relationship.hubOrigin);
    const socket = new URL(record.transport.webSocketUrl);
    const expectedProtocol = hub.protocol === "https:" ? "wss:" : "ws:";
    if (socket.protocol === expectedProtocol && socket.host === hub.host) return;
    context.addIssue({
      code: "custom",
      path: ["transport", "webSocketUrl"],
      message: "Hub WebSocket URL must match the Hub origin",
    });
  });
const RecordSchema = z.preprocess(migrateLegacyRecord, CurrentRecordSchema);
type PendingRecord = z.infer<typeof PendingSchema>;
type ActiveRecord = z.infer<typeof ActiveSchema>;
type DisconnectingRecord = z.infer<typeof DisconnectingSchema>;
type RevokedRecord = z.infer<typeof RevokedSchema>;
type HubRelationshipRecord = z.infer<typeof RecordSchema>;

export type HubConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "revoked";

export interface HubRelationshipStatus {
  state: HubConnectionState;
  daemonId: string | null;
  hubOrigin: string | null;
  permissions: DaemonPermission[];
  connectedAt: string | null;
  lastError: string | null;
}

export interface HubRelationshipManagement {
  connect(input: {
    hubUrl: string;
    token: string;
    permissions: readonly string[];
  }): Promise<HubRelationshipStatus>;
  updatePermissions(input: {
    grant: readonly string[];
    revoke: readonly string[];
  }): Promise<HubRelationshipStatus>;
  status(): HubRelationshipStatus;
  disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }>;
}

export interface ScheduledRelationshipTask {
  cancel(): void;
}

export interface HubRelationshipClock {
  now(): Date;
  schedule(delayMs: number, task: () => void): ScheduledRelationshipTask;
}

export interface HubRelationshipRetryPolicy {
  delay(attempt: number): number;
}

export interface HubRelationshipControllerOptions {
  paseoHome: string;
  hostname: string;
  serverId: string;
  daemonPublicKey: string;
  logger: pino.Logger;
  remote: HubRelationshipRemote;
  clock?: HubRelationshipClock;
  retryPolicy?: HubRelationshipRetryPolicy;
  createDaemonId?: () => string;
  attachSocket: (
    socket: WebSocketLike,
    options: {
      daemonId: string;
      principalId: string;
      permissions: readonly DaemonPermission[];
      agents: HubExecutionAgents;
      sessionProtocol: "legacy" | "session-v1";
    },
  ) => Promise<void>;
  updateAttachedPermissions: (
    principalId: string,
    permissions: readonly DaemonPermission[],
  ) => void;
  createExecutionAgents: (daemonId: string) => HubExecutionAgents;
}

const systemClock: HubRelationshipClock = {
  now: () => new Date(),
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function normalizeHubUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hub URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Hub URL cannot include credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Hub URL cannot include a query or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export class HubRelationshipController implements HubRelationshipManagement {
  private readonly filePath: string;
  private readonly clock: HubRelationshipClock;
  private readonly retryPolicy: HubRelationshipRetryPolicy;
  private record: HubRelationshipRecord | null;
  private state: HubConnectionState = "not_connected";
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private socket: HubSocketConnection | null = null;
  private retry: ScheduledRelationshipTask | null = null;
  private generation = 0;
  private enrollmentGeneration = 0;
  private retryAttempt = 0;
  private readonly inFlightEnrollments = new Set<Promise<void>>();
  private executionAgents: { daemonId: string; value: HubExecutionAgents } | null = null;

  constructor(private readonly options: HubRelationshipControllerOptions) {
    this.filePath = path.join(options.paseoHome, FILE_NAME);
    this.clock = options.clock ?? systemClock;
    this.retryPolicy = options.retryPolicy ?? new BoundedExponentialHubRetryPolicy();
    this.record = this.load();
    if (this.record?.state === "disconnecting") {
      // COMPAT(hubUnilateralDisconnect): added in v0.4.0, remove after 2027-02-13 once legacy records have aged out.
      this.options.logger.warn(
        { daemonId: this.record.relationship.daemonId },
        "Removed legacy disconnecting Hub relationship during startup",
      );
      rmSync(this.filePath, { force: true });
      this.record = null;
    }
    if (this.record?.state === "revoked") {
      this.state = "revoked";
      this.lastError = this.record.reason ?? null;
    } else if (this.record) this.state = "connecting";
  }

  async start(): Promise<void> {
    if (this.record?.state === "active") this.openSocket(this.record, false);
    if (this.record?.state === "pending") {
      const enrollmentGeneration = this.beginEnrollmentAttempt();
      try {
        await this.tryEnrollment(this.record, enrollmentGeneration);
      } catch (error) {
        if (!(error instanceof HubEnrollmentRejectedError)) throw error;
        this.options.logger.warn(
          { statusCode: error.statusCode },
          "Discarded rejected pending Hub enrollment during startup",
        );
      }
    }
  }

  async stop(): Promise<void> {
    const pendingExecutionCleanup = this.retireExecutionAgents();
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    await pendingExecutionCleanup;
  }

  status(): HubRelationshipStatus {
    return {
      state: this.state,
      daemonId: this.record?.relationship.daemonId ?? null,
      hubOrigin: this.record?.relationship.hubOrigin ?? null,
      permissions: this.record?.relationship.permissions.slice() ?? [],
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  async connect(input: {
    hubUrl: string;
    token: string;
    permissions: readonly string[];
  }): Promise<HubRelationshipStatus> {
    const permissions = parseDaemonPermissions(input.permissions);
    if (this.record?.state === "pending") {
      if (normalizeHubUrl(input.hubUrl) !== this.record.relationship.hubOrigin) {
        throw new Error("A pending Hub enrollment already exists for a different Hub");
      }
      this.record = { ...this.record, enrollment: { token: input.token } };
      const enrollmentGeneration = this.beginEnrollmentAttempt();
      this.persist(this.record);
      this.state = "connecting";
      this.lastError = null;
      await this.tryEnrollment(this.record, enrollmentGeneration);
      return this.status();
    }
    if (this.record && this.record.state !== "revoked") {
      throw new Error("This daemon already has a Hub relationship");
    }
    const pending: PendingRecord = {
      version: 2,
      state: "pending",
      relationship: {
        daemonId: this.options.createDaemonId?.() ?? randomUUID(),
        idempotencyKey: randomUUID(),
        hubOrigin: normalizeHubUrl(input.hubUrl),
        createdAt: this.clock.now().toISOString(),
        permissions,
      },
      credential: { secret: randomBytes(32).toString("base64url") },
      enrollment: { token: input.token },
      identity: { serverId: this.options.serverId, daemonPublicKey: this.options.daemonPublicKey },
    };
    this.persist(pending);
    this.record = pending;
    this.state = "connecting";
    this.lastError = null;
    await this.tryEnrollment(pending, this.beginEnrollmentAttempt());
    return this.status();
  }

  async updatePermissions(input: {
    grant: readonly string[];
    revoke: readonly string[];
  }): Promise<HubRelationshipStatus> {
    if (!this.record || this.record.state !== "active") {
      throw new Error("This daemon is not connected to a Hub");
    }
    const grant = parseDaemonPermissions(input.grant);
    const revoke = parseDaemonPermissions(input.revoke);
    const permissions = parseDaemonPermissions([
      ...this.record.relationship.permissions.filter((permission) => !revoke.includes(permission)),
      ...grant,
    ]);
    const result = await this.options.remote.updatePermissions({
      daemonId: this.record.relationship.daemonId,
      hubOrigin: this.record.relationship.hubOrigin,
      credential: this.record.credential.secret,
      permissions,
    });
    if (!samePermissions(result.permissions, permissions)) {
      throw new Error("Hub permission response did not match the local grant");
    }
    this.record = {
      ...this.record,
      relationship: { ...this.record.relationship, permissions },
    };
    this.persist(this.record);
    this.options.updateAttachedPermissions(hubPrincipalId(this.record), permissions);
    return this.status();
  }

  async disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }> {
    const waitForEnrollment = this.record?.state === "pending";
    const pendingCreateCleanup = this.retireExecutionAgents();
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    if (!this.record || this.record.state === "revoked") {
      this.remove();
      await pendingCreateCleanup;
      return { status: this.status() };
    }
    const disconnecting: DisconnectingRecord = {
      version: 2,
      state: "disconnecting",
      relationship: this.record.relationship,
      credential: this.record.credential,
      ...(this.record.state === "active" ? { transport: this.record.transport } : {}),
    };
    this.persist(disconnecting);
    this.record = disconnecting;
    this.state = "disconnecting";
    if (waitForEnrollment && !input.force) {
      await Promise.all(this.inFlightEnrollments);
    }
    let warning: string | undefined;
    if (!input.force) {
      try {
        await this.options.remote.revoke({
          daemonId: disconnecting.relationship.daemonId,
          hubOrigin: disconnecting.relationship.hubOrigin,
          credential: disconnecting.credential.secret,
        });
      } catch (error) {
        this.options.logger.warn(
          { err: error, daemonId: disconnecting.relationship.daemonId },
          "Failed to notify Hub before removing local relationship",
        );
        warning =
          "Hub could not be reached; local relationship removed, but server-side revocation may remain pending.";
      }
    }
    this.remove();
    await pendingCreateCleanup;
    return { status: this.status(), ...(warning ? { warning } : {}) };
  }

  private async tryEnrollment(pending: PendingRecord, enrollmentGeneration: number): Promise<void> {
    if (enrollmentGeneration !== this.enrollmentGeneration) return;
    const verifier = createHash("sha256").update(pending.credential.secret).digest("base64url");
    const request = this.options.remote.enroll({
      daemonId: pending.relationship.daemonId,
      idempotencyKey: pending.relationship.idempotencyKey,
      hubOrigin: pending.relationship.hubOrigin,
      token: pending.enrollment.token,
      hostname: this.options.hostname,
      serverId: pending.identity.serverId,
      daemonPublicKey: pending.identity.daemonPublicKey,
      credentialVerifier: verifier,
      permissions: pending.relationship.permissions,
    });
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    this.inFlightEnrollments.add(settled);
    try {
      const enrollment = await request;
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      if (
        enrollment.daemonId !== pending.relationship.daemonId ||
        !samePermissions(enrollment.permissions, pending.relationship.permissions)
      ) {
        throw new Error("Hub enrollment response did not match the pending relationship");
      }
      const active: ActiveRecord = {
        version: 2,
        state: "active",
        relationship: pending.relationship,
        credential: pending.credential,
        transport: { kind: "direct_websocket", webSocketUrl: enrollment.webSocketUrl },
      };
      this.persist(active);
      this.record = active;
      this.retry = null;
      this.retryAttempt = 0;
      this.openSocket(active, false);
    } catch (error) {
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      if (error instanceof HubEnrollmentRejectedError) {
        this.remove();
        throw error;
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleEnrollment(pending, enrollmentGeneration);
    } finally {
      this.inFlightEnrollments.delete(settled);
    }
  }

  private openSocket(record: ActiveRecord, reconnecting: boolean): void {
    const generation = ++this.generation;
    this.state = reconnecting ? "reconnecting" : "connecting";
    const events: HubSocketEvents = {
      connected: (socket, sessionProtocol) =>
        this.socketConnected(generation, record, socket, sessionProtocol),
      rejected: (statusCode) => this.socketRejected(generation, statusCode),
      closed: (code) => this.socketClosed(generation, record, code),
      failed: (error) => this.socketFailed(generation, record, error),
    };
    this.socket = this.options.remote.openSocket(
      {
        daemonId: record.relationship.daemonId,
        webSocketUrl: record.transport.webSocketUrl,
        credential: record.credential.secret,
      },
      events,
    );
  }

  private socketConnected(
    generation: number,
    record: ActiveRecord,
    socket: WebSocketLike,
    sessionProtocol: "legacy" | "session-v1",
  ): void {
    if (generation !== this.generation) {
      socket.close();
      return;
    }
    this.retryAttempt = 0;
    this.state = "connected";
    this.connectedAt = this.clock.now().toISOString();
    this.lastError = null;
    void this.options.attachSocket(socket, {
      daemonId: record.relationship.daemonId,
      principalId: hubPrincipalId(record),
      permissions: record.relationship.permissions,
      agents: this.executionAgentsFor(record.relationship.daemonId),
      sessionProtocol,
    });
  }

  private executionAgentsFor(daemonId: string): HubExecutionAgents {
    if (this.executionAgents?.daemonId === daemonId) return this.executionAgents.value;
    const value = this.options.createExecutionAgents(daemonId);
    this.executionAgents = { daemonId, value };
    return value;
  }

  private retireExecutionAgents(): Promise<void> {
    const executionAgents = this.executionAgents;
    this.executionAgents = null;
    return executionAgents?.value.invalidateAuthority() ?? Promise.resolve();
  }

  private socketRejected(generation: number, statusCode: 401 | 403): void {
    if (generation !== this.generation) return;
    this.revoke(`Hub rejected socket authentication (${statusCode})`);
  }

  private socketClosed(generation: number, record: ActiveRecord, code: number): void {
    if (generation !== this.generation) return;
    if (code === 4403) {
      this.revoke("Hub revoked this relationship");
      return;
    }
    if (this.record?.state === "active") this.scheduleSocket(record);
  }

  private socketFailed(generation: number, record: ActiveRecord, error: Error): void {
    if (generation !== this.generation) return;
    this.lastError = error.message;
    if (this.record?.state === "active") this.scheduleSocket(record);
  }

  private scheduleSocket(record: ActiveRecord): void {
    this.state = "reconnecting";
    this.schedule(() => this.openSocket(record, true));
  }

  private scheduleEnrollment(record: PendingRecord, enrollmentGeneration: number): void {
    if (enrollmentGeneration !== this.enrollmentGeneration) return;
    this.state = "reconnecting";
    this.retry?.cancel();
    const delay = this.retryPolicy.delay(this.retryAttempt++);
    this.retry = this.clock.schedule(delay, () => {
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      void this.tryEnrollment(record, enrollmentGeneration).catch((error: unknown) => {
        if (error instanceof HubEnrollmentRejectedError) return;
        this.options.logger.error({ err: error }, "Scheduled Hub enrollment retry failed");
      });
    });
  }

  private schedule(task: () => void): void {
    this.retry?.cancel();
    const generation = this.generation;
    const delay = this.retryPolicy.delay(this.retryAttempt++);
    this.retry = this.clock.schedule(delay, () => {
      if (generation === this.generation) task();
    });
  }

  private revoke(reason: string): void {
    void this.retireExecutionAgents();
    this.cancelLifecycle();
    if (!this.record) return;
    const revoked: RevokedRecord = {
      version: 2,
      state: "revoked",
      relationship: {
        daemonId: this.record.relationship.daemonId,
        hubOrigin: this.record.relationship.hubOrigin,
        createdAt: this.record.relationship.createdAt,
        permissions: this.record.relationship.permissions,
      },
      transport: "transport" in this.record ? this.record.transport : undefined,
      reason,
    };
    this.persist(revoked);
    this.record = revoked;
    this.state = "revoked";
    this.lastError = reason;
  }

  private cancelLifecycle(): void {
    ++this.generation;
    ++this.enrollmentGeneration;
    this.retry?.cancel();
    this.retry = null;
  }

  private beginEnrollmentAttempt(): number {
    this.retry?.cancel();
    this.retry = null;
    this.retryAttempt = 0;
    return ++this.enrollmentGeneration;
  }

  private persist(record: HubRelationshipRecord): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private remove(): void {
    void this.retireExecutionAgents();
    this.cancelLifecycle();
    rmSync(this.filePath, { force: true });
    this.record = null;
    this.state = "not_connected";
    this.connectedAt = null;
    this.lastError = null;
  }

  private load(): HubRelationshipRecord | null {
    if (!existsSync(this.filePath)) return null;
    let record: HubRelationshipRecord;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      record = RecordSchema.parse(raw);
      if (isLegacyRecord(raw)) this.persist(record);
    } catch (error) {
      const quarantinePath = path.join(
        path.dirname(this.filePath),
        `hub-relationship.invalid-${this.clock.now().getTime()}-${randomUUID()}.json`,
      );
      renameSync(this.filePath, quarantinePath);
      ensurePrivateFile(quarantinePath);
      this.options.logger.error(
        { err: error, quarantinePath },
        "Quarantined invalid Hub relationship authority",
      );
      return null;
    }
    ensurePrivateFile(this.filePath);
    return record;
  }
}

function hubPrincipalId(record: ActiveRecord): string {
  const credentialFingerprint = createHash("sha256")
    .update(record.credential.secret)
    .digest("base64url");
  return `hub:${record.relationship.daemonId}:${credentialFingerprint}`;
}

function samePermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((scope) => actual.includes(scope));
}

function isLegacyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

function migrateLegacyRecord(value: unknown): unknown {
  if (!isLegacyRecord(value)) return value;
  const relationship = Reflect.get(value, "relationship");
  if (typeof relationship !== "object" || relationship === null) return value;
  const scopes = Reflect.get(relationship, "scopes");
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return value;
  const { scopes: _legacyScopes, ...relationshipWithoutScopes } = relationship as Record<
    string,
    unknown
  >;
  return {
    ...(value as Record<string, unknown>),
    version: 2,
    relationship: {
      ...relationshipWithoutScopes,
      permissions: permissionsForLegacyHubScopes(scopes),
    },
  };
}
