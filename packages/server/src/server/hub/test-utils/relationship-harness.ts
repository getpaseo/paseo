import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, realpathSync, statSync, watch } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, platform, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Writable } from "node:stream";
import pino from "pino";
import { WebSocket } from "ws";
import type {
  AgentSnapshotPayload,
  HubExecutionAgentCreateResponse,
  HubExecutionAgentStream,
  HubExecutionAgentUpdate,
  RpcErrorMessage,
  CreateAgentWorktreeTarget,
  SessionOutboundMessage,
} from "../../messages.js";
import { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "../../bootstrap.js";
import type { WebSocketLike } from "../../websocket-server.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPromptInput,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ProviderCatalog,
} from "../../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { AgentStorage } from "../../agent/agent-storage.js";
import { AgentManager } from "../../agent/agent-manager.js";
import { DaemonExecutions } from "../daemon-executions.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "../../agent/create-agent/create.js";
import type {
  HubRelationshipClock,
  HubRelationshipRetryPolicy,
  ScheduledRelationshipTask,
} from "../relationship-controller.js";
import type {
  HubEnrollment,
  HubEnrollmentResult,
  HubRelationshipRemote,
  HubRevocation,
  HubSocketConnection,
  HubSocketCredentials,
  HubSocketEvents,
} from "../relationship-remote.js";
import { HubEnrollmentRejectedError } from "../relationship-remote.js";

const execFileAsync = promisify(execFile);
const HUB_ORIGIN = "https://hub.test";
const SOCKET_URL = "wss://hub.test/daemon";
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../../../..");

export interface ArchiveWatcher {
  close(): void;
  onError(listener: (error: Error) => void): void;
}

export interface ArchiveWatchFiles {
  watchDirectory(path: string, onChange: () => void): ArchiveWatcher;
}

const nodeArchiveWatchFiles: ArchiveWatchFiles = {
  watchDirectory(directory, onChange) {
    const watcher = watch(directory, onChange);
    return {
      close: () => watcher.close(),
      onError: (listener) => watcher.on("error", listener),
    };
  },
};

export class SetupFailingArchiveWatchFiles implements ArchiveWatchFiles {
  private attempts = 0;
  private readonly openDirectories = new Set<string>();

  constructor(private readonly failOnAttempt: number) {}

  watchDirectory(directory: string): ArchiveWatcher {
    this.attempts++;
    if (this.attempts === this.failOnAttempt) {
      throw new Error(`Cannot watch ${directory}`);
    }
    this.openDirectories.add(directory);
    let open = true;
    return {
      close: () => {
        if (!open) return;
        open = false;
        this.openDirectories.delete(directory);
      },
      onError: () => {},
    };
  }

  activeDirectories(): string[] {
    return [...this.openDirectories];
  }
}

interface PersistedRelationship {
  version: number;
  state: string;
  reason?: string;
  relationship: {
    daemonId: string;
    idempotencyKey?: string;
    hubOrigin: string;
    scopes: string[];
  };
  credential?: { secret: string };
  enrollment?: { token: string };
  identity?: { serverId: string; daemonPublicKey: string };
}

export interface RelationshipInvocationSnapshot {
  mode: number;
  record: PersistedRelationship;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class TestRelationshipClock implements HubRelationshipClock, HubRelationshipRetryPolicy {
  private current = new Date("2026-07-13T00:00:00.000Z");
  private tasks: Array<{ cancelled: boolean; task: () => void }> = [];

  now(): Date {
    return this.current;
  }

  delay(attempt: number): number {
    return Math.min(8_000, 1_000 * 2 ** attempt);
  }

  schedule(_delayMs: number, task: () => void): ScheduledRelationshipTask {
    const scheduled = { cancelled: false, task };
    this.tasks.push(scheduled);
    return { cancel: () => (scheduled.cancelled = true) };
  }

  async runNext(): Promise<void> {
    while (true) {
      const scheduled = this.tasks.shift();
      if (!scheduled) throw new Error("No relationship retry is scheduled");
      if (!scheduled.cancelled) {
        scheduled.task();
        await Promise.resolve();
        return;
      }
    }
  }

  pendingTasks(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }
}

class MemoryHubSocket extends EventEmitter implements WebSocketLike, HubSocketConnection {
  readyState = 1;
  bufferedAmount = 0;
  sent: SessionOutboundMessage[] = [];
  closed = false;
  closeCode: number | null = null;
  private messageObserved = deferred<void>();

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const frame = JSON.parse(data) as { type: "session"; message: SessionOutboundMessage };
    this.sent.push(frame.message);
    this.messageObserved.resolve();
  }

  close(code = 1000): void {
    this.closed = true;
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close", code);
  }

  receive(message: unknown): void {
    this.emit("message", JSON.stringify({ type: "session", message }), false);
  }

  receiveEnvelope(message: unknown): void {
    this.emit("message", JSON.stringify(message), false);
  }

  receiveBinary(): void {
    this.emit("message", new Uint8Array([1, 2, 3]), true);
  }

  async messageFor(requestId: string): Promise<SessionOutboundMessage> {
    while (true) {
      const message = this.sent.find(
        (candidate) =>
          "payload" in candidate &&
          "requestId" in candidate.payload &&
          candidate.payload.requestId === requestId,
      );
      if (message) return message;
      await this.messageObserved.promise;
      this.messageObserved = deferred<void>();
    }
  }

  async messageMatching<TMessage extends SessionOutboundMessage>(
    predicate: (message: SessionOutboundMessage) => message is TMessage,
  ): Promise<TMessage> {
    while (true) {
      const message = this.sent.find(predicate);
      if (message) return message;
      await this.messageObserved.promise;
      this.messageObserved = deferred<void>();
    }
  }
}

class ControlledAgentClient implements AgentClient {
  readonly provider;
  readonly capabilities;
  private gate: Deferred<void> | null = null;
  private creationObserved = deferred<void>();
  creations = 0;
  resumes = 0;
  createdConfigs: AgentSessionConfig[] = [];

  constructor(private readonly client: AgentClient) {
    this.provider = client.provider;
    this.capabilities = client.capabilities;
  }

  holdCreation(): void {
    this.gate = deferred<void>();
  }

  async creationAt(count: number): Promise<void> {
    while (this.creations < count) {
      await this.creationObserved.promise;
      this.creationObserved = deferred<void>();
    }
  }

  finishCreation(): void {
    if (!this.gate) throw new Error("Agent creation is not held");
    this.gate.resolve();
    this.gate = null;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    this.creations++;
    this.createdConfigs.push({ ...config });
    this.creationObserved.resolve();
    await this.gate?.promise;
    return this.client.createSession(config, launchContext, options);
  }

  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumes++;
    return this.client.resumeSession(handle, overrides, launchContext);
  }

  fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    return this.client.fetchCatalog(options);
  }

  isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }
}

interface SocketAttempt {
  input: HubSocketCredentials;
  events: HubSocketEvents;
  socket: MemoryHubSocket;
}

class InMemoryHubRelationships implements HubRelationshipRemote {
  enrollments: HubEnrollment[] = [];
  revocations: HubRevocation[] = [];
  sockets: SocketAttempt[] = [];
  private readonly enrollmentGates: Array<Deferred<HubEnrollmentResult>> = [];
  private readonly heldEnrollments: Array<{
    input: HubEnrollment;
    gate: Deferred<HubEnrollmentResult>;
  }> = [];
  private enrollmentObserved = deferred<void>();
  private socketObserved = deferred<void>();
  private enrollmentRejection: 401 | 403 | null = null;
  private enrollmentScopes = ["hub.execution.*"];
  private revokeFailures = 0;
  private readonly relationships = new Set<string>();
  readonly enrollmentSnapshots: RelationshipInvocationSnapshot[] = [];
  readonly socketSnapshots: RelationshipInvocationSnapshot[] = [];

  constructor(private readonly captureRelationship: () => RelationshipInvocationSnapshot) {}

  holdEnrollment(): void {
    this.enrollmentGates.push(deferred<HubEnrollmentResult>());
  }

  rejectNextEnrollment(statusCode: 401 | 403): void {
    this.enrollmentRejection = statusCode;
  }

  returnEnrollmentScopes(scopes: string[]): void {
    this.enrollmentScopes = scopes.slice();
  }

  async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
    this.enrollmentSnapshots.push(this.captureRelationship());
    this.enrollments.push({ ...input, scopes: input.scopes.slice() });
    this.relationships.add(input.idempotencyKey);
    this.enrollmentObserved.resolve();
    if (this.enrollmentRejection) {
      const statusCode = this.enrollmentRejection;
      this.enrollmentRejection = null;
      throw new HubEnrollmentRejectedError(statusCode);
    }
    const gate = this.enrollmentGates.shift();
    if (gate) {
      this.heldEnrollments.push({ input, gate });
      return gate.promise;
    }
    return this.enrollmentResult(input);
  }

  completeEnrollment(): void {
    const held = this.heldEnrollments.at(-1);
    if (!held) throw new Error("No enrollment is waiting");
    held.gate.resolve(this.enrollmentResult(held.input));
    this.heldEnrollments.splice(this.heldEnrollments.indexOf(held), 1);
  }

  loseEnrollmentResponse(): void {
    const held = this.heldEnrollments.at(-1);
    if (!held) throw new Error("No enrollment is waiting");
    held.gate.reject(new Error("Enrollment response was lost"));
    this.heldEnrollments.splice(this.heldEnrollments.indexOf(held), 1);
  }

  rejectEnrollment(index: number, statusCode: 401 | 403): void {
    const held = this.heldEnrollments[index];
    if (!held) throw new Error(`Enrollment ${index} is not waiting`);
    held.gate.reject(new HubEnrollmentRejectedError(statusCode));
    this.heldEnrollments.splice(index, 1);
  }

  async enrollmentAt(index: number): Promise<HubEnrollment> {
    while (!this.enrollments[index]) {
      await this.enrollmentObserved.promise;
      this.enrollmentObserved = deferred<void>();
    }
    return this.enrollments[index];
  }

  failRevocations(count: number): void {
    this.revokeFailures = count;
  }

  async revoke(input: HubRevocation): Promise<void> {
    this.revocations.push({ ...input });
    if (this.revokeFailures > 0) {
      this.revokeFailures--;
      throw new Error("Hub is offline");
    }
  }

  openSocket(input: HubSocketCredentials, events: HubSocketEvents): HubSocketConnection {
    this.socketSnapshots.push(this.captureRelationship());
    const attempt = { input: { ...input }, events, socket: new MemoryHubSocket() };
    this.sockets.push(attempt);
    this.socketObserved.resolve();
    return attempt.socket;
  }

  async socketAt(index: number): Promise<SocketAttempt> {
    while (!this.sockets[index]) {
      await this.socketObserved.promise;
      this.socketObserved = deferred<void>();
    }
    return this.sockets[index];
  }

  relationshipCount(): number {
    return this.relationships.size;
  }

  private enrollmentResult(input: HubEnrollment): HubEnrollmentResult {
    return {
      daemonId: input.daemonId,
      scopes: this.enrollmentScopes.slice(),
      webSocketUrl: SOCKET_URL,
    };
  }
}

interface CliProcess {
  result: Promise<Record<string, unknown>>;
}

type AcceptedCreate = Omit<
  HubExecutionAgentCreateResponse["payload"],
  "agentId" | "agent" | "success"
> & {
  agentId: string;
  agent: AgentSnapshotPayload;
  success: true;
};

const providerCatalog = {
  async resolveCreateConfig(input) {
    return { modeId: input.requestedMode, featureValues: input.featureValues };
  },
} satisfies CreateAgentCommandDependencies["providerSnapshotManager"];

export class HubRelationshipHarness {
  private readonly clock = new TestRelationshipClock();
  private readonly remote = new InMemoryHubRelationships(() => this.captureRelationship());
  private daemon: PaseoDaemon | null = null;
  private config!: PaseoDaemonConfig;
  private root = "";
  private paseoHome = "";
  private host = "";
  private readonly logs: string[] = [];
  private readonly providerPrompts: AgentPromptInput[] = [];
  private readonly cliProcesses = new Set<Promise<unknown>>();
  private readonly claimedCliSockets = new Set<WebSocket>();
  private readonly promptsToFail = new Set<string>();
  private failNextSessionClose = false;
  private observedEnrollments = 0;
  private observedSockets = 0;
  private readonly codex = new ControlledAgentClient(
    createTestAgentClients({
      closeSession: async () => {
        if (!this.failNextSessionClose) return;
        this.failNextSessionClose = false;
        throw new Error("Requested provider session close failure");
      },
      onStartTurn: (prompt) => {
        const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        if (this.promptsToFail.delete(promptText)) {
          throw new Error("Requested provider prompt startup failure");
        }
        this.providerPrompts.push(prompt);
      },
    }).codex,
  );

  private constructor(private readonly archiveWatchFiles: ArchiveWatchFiles) {}

  static async start(
    archiveWatchFiles: ArchiveWatchFiles = nodeArchiveWatchFiles,
  ): Promise<HubRelationshipHarness> {
    const harness = new HubRelationshipHarness(archiveWatchFiles);
    await harness.createHome();
    await harness.startDaemon();
    return harness;
  }

  holdEnrollment(): void {
    this.remote.holdEnrollment();
  }

  beginConnect(token = "ceremony-token", hubUrl = HUB_ORIGIN): CliProcess {
    return { result: this.runCli(["hub", "connect", hubUrl, "--token", token]) };
  }

  async status(): Promise<Record<string, unknown>> {
    return this.runCli(["hub", "status"]);
  }

  async disconnect(force = false): Promise<Record<string, unknown>> {
    return this.runCli(["hub", "disconnect", ...(force ? ["--force"] : [])]);
  }

  beginDisconnect(force = false): CliProcess {
    return { result: this.runCli(["hub", "disconnect", ...(force ? ["--force"] : [])]) };
  }

  async relationshipStateBecomes(expected: string | null): Promise<void> {
    const observed = deferred<void>();
    const watcher = watch(this.paseoHome, () => {
      if ((this.relationshipFile()?.state ?? null) === expected) observed.resolve();
    });
    if ((this.relationshipFile()?.state ?? null) === expected) observed.resolve();
    try {
      await observed.promise;
    } finally {
      watcher.close();
    }
  }

  async manageRelationshipFromExternalSocket(): Promise<SessionOutboundMessage[]> {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((candidate) => candidate?.family === "IPv4" && !candidate.internal)?.address;
    if (!address)
      throw new Error("No non-loopback IPv4 address is available for the external test");
    const target = this.daemon?.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Daemon did not bind TCP");
    const socket = await this.openClaimedCliSocket(`ws://${address}:${target.port}/ws`);
    const messages = [
      {
        type: "hub.management.daemon.connect.request",
        requestId: "external-hub-connect",
        hubUrl: HUB_ORIGIN,
        token: "external-token",
      },
      { type: "hub.management.daemon.get_status.request", requestId: "external-hub-status" },
      {
        type: "hub.management.daemon.disconnect.request",
        requestId: "external-hub-disconnect",
        force: false,
      },
    ];
    const responses: SessionOutboundMessage[] = [];
    for (const message of messages) {
      socket.send(JSON.stringify({ type: "session", message }));
      responses.push((await this.nextSocketEnvelope(socket)).message);
    }
    await this.closeClaimedCliSocket(socket);
    return responses;
  }

  async connectFromBrowserSocket(): Promise<SessionOutboundMessage> {
    const target = this.daemon?.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Daemon did not bind TCP");
    const socket = await this.openClaimedCliSocket(`ws://127.0.0.1:${target.port}/ws`, {
      origin: `http://127.0.0.1:${target.port}`,
    });
    socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "hub.management.daemon.connect.request",
          requestId: "browser-hub-connect",
          hubUrl: HUB_ORIGIN,
          token: "browser-token",
        },
      }),
    );
    const response = (await this.nextSocketEnvelope(socket)).message;
    await this.closeClaimedCliSocket(socket);
    return response;
  }

  async enrollmentBegins(): Promise<HubEnrollment> {
    return this.remote.enrollmentAt(this.observedEnrollments++);
  }

  completeEnrollment(): void {
    this.remote.completeEnrollment();
  }

  returnEnrollmentScopes(scopes: string[]): void {
    this.remote.returnEnrollmentScopes(scopes);
  }

  loseEnrollmentResponse(): void {
    this.remote.loseEnrollmentResponse();
  }

  rejectEnrollment(index: number, statusCode: 401 | 403): void {
    this.remote.rejectEnrollment(index, statusCode);
  }

  pendingRelationshipRetries(): number {
    return this.clock.pendingTasks();
  }

  rejectNextEnrollment(statusCode: 401 | 403): void {
    this.remote.rejectNextEnrollment(statusCode);
  }

  failRevocations(count: number): void {
    this.remote.failRevocations(count);
  }

  failProviderPromptStart(prompt = "Create through the Hub"): void {
    this.promptsToFail.add(prompt);
  }

  failNextProviderSessionClose(): void {
    this.failNextSessionClose = true;
  }

  async socketDialed(): Promise<void> {
    await this.remote.socketAt(this.observedSockets++);
  }

  connectLatestSocket(): void {
    const socket = this.latestSocket();
    socket.events.connected(socket.socket);
  }

  rejectLatestSocket(statusCode: 401 | 403): void {
    this.latestSocket().events.rejected(statusCode);
  }

  rejectRelationship(code: 4403 | 401 | 403): void {
    if (code === 4403) {
      this.closeLatestSocket(code);
      return;
    }
    this.rejectLatestSocket(code);
  }

  closeLatestSocket(code: number): void {
    const socket = this.latestSocket();
    socket.events.closed(code);
    socket.socket.close(code);
  }

  connectSocket(index: number): void {
    const socket = this.remote.sockets[index];
    if (!socket) throw new Error(`Socket ${index} does not exist`);
    socket.events.connected(socket.socket);
  }

  closeSocket(index: number, code: number): void {
    const socket = this.remote.sockets[index];
    if (!socket) throw new Error(`Socket ${index} does not exist`);
    socket.events.closed(code);
    socket.socket.close(code);
  }

  sendHubRequestOnLatest(message: unknown): SessionOutboundMessage[] {
    const socket = this.latestSocket().socket;
    socket.receive(message);
    return socket.sent.slice();
  }

  holdAgentCreation(): void {
    this.codex.holdCreation();
  }

  beginOwnedCreate(
    requestId: string,
    executionId = "execution-race",
    options: {
      worktree?: CreateAgentWorktreeTarget;
      autoArchive?: boolean;
      prompt?: string;
      modeId?: string;
    } = {},
  ): void {
    const { prompt = "Create through the Hub", ...requestOptions } = options;
    this.latestSocket().socket.receive({
      type: "hub.execution.agent.create.request",
      requestId,
      executionId,
      provider: "codex",
      cwd: this.root,
      workspaceId: "hub-workspace",
      prompt,
      ...requestOptions,
    });
  }

  async agentCreationAttempts(count: number): Promise<void> {
    await this.codex.creationAt(count);
  }

  finishAgentCreation(): void {
    this.codex.finishCreation();
  }

  async ownedCreateResult(requestId: string): Promise<SessionOutboundMessage> {
    return this.latestSocket().socket.messageFor(requestId);
  }

  async durableOwnedAgentIds(): Promise<string[]> {
    return (await this.daemon!.agentStorage.list())
      .filter((record) => record.owner?.kind === "daemon")
      .map((record) => record.id);
  }

  async durableOwnedAgentIdsOnDisk(): Promise<string[]> {
    const storage = new AgentStorage(
      path.join(this.paseoHome, "agents"),
      pino({ level: "silent" }),
    );
    return (await storage.list())
      .filter((record) => record.owner?.kind === "daemon")
      .map((record) => record.id);
  }

  activeOwnedAgentIds(): string[] {
    return this.daemon!.agentManager.listAgents()
      .filter((agent) => agent.owner?.kind === "daemon")
      .map((agent) => agent.id);
  }

  agentSubscriptionCount(): number {
    return this.daemon!.agentManager.subscriptionCount();
  }

  async hubExecutionIntentFiles(): Promise<string[]> {
    const directory = path.join(this.paseoHome, "hub-executions");
    return existsSync(directory) ? readdir(directory) : [];
  }

  socketDeliveredResponse(socketIndex: number, requestId: string): boolean {
    const socket = this.remote.sockets[socketIndex];
    if (!socket) throw new Error(`Socket ${socketIndex} does not exist`);
    return socket.socket.sent.some(
      (message) =>
        "payload" in message &&
        "requestId" in message.payload &&
        message.payload.requestId === requestId,
    );
  }

  providerCreations(): number {
    return this.codex.creations;
  }

  providerResumes(): number {
    return this.codex.resumes;
  }

  providerPromptTexts(): string[] {
    return this.providerPrompts.map((prompt) =>
      typeof prompt === "string" ? prompt : JSON.stringify(prompt),
    );
  }

  latestCreatedCwd(): string | null {
    return this.codex.createdConfigs.at(-1)?.cwd ?? null;
  }

  repoRoot(): string {
    return this.root;
  }

  async waitForOwnedArchiveCompletion(
    agentId: string,
  ): Promise<{ agentArchivedAt: string; workspaceArchivedAt: string }> {
    const created = await this.daemon!.agentStorage.get(agentId);
    if (!created) throw new Error(`Owned agent ${agentId} does not exist`);
    if (!created.workspaceId) throw new Error(`Owned agent ${agentId} has no workspace`);
    return new Promise<{ agentArchivedAt: string; workspaceArchivedAt: string }>(
      (resolve, reject) => {
        const watchers: ArchiveWatcher[] = [];
        let settled = false;
        const timeout = setTimeout(
          () => finish(new Error(`Timed out waiting for owned agent ${agentId} to archive`)),
          15_000,
        );
        timeout.unref?.();
        const closeWatchers = () => {
          clearTimeout(timeout);
          for (const watcher of watchers) watcher.close();
        };
        const finish = (
          result: Error | { agentArchivedAt: string; workspaceArchivedAt: string },
        ) => {
          if (settled) return;
          settled = true;
          closeWatchers();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const observeCompletion = async () => {
          try {
            const archived = await this.daemon!.agentStorage.get(agentId);
            const workspaceArchivedAt = this.workspaceArchivedAt(created.workspaceId!);
            if (!archived?.archivedAt || !workspaceArchivedAt || existsSync(created.cwd)) return;
            finish({ agentArchivedAt: archived.archivedAt, workspaceArchivedAt });
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        try {
          const projectsWatcher = this.archiveWatchFiles.watchDirectory(
            path.join(this.paseoHome, "projects"),
            observeCompletion,
          );
          watchers.push(projectsWatcher);
          projectsWatcher.onError(finish);
          const worktreeWatcher = this.archiveWatchFiles.watchDirectory(
            path.dirname(created.cwd),
            observeCompletion,
          );
          watchers.push(worktreeWatcher);
          worktreeWatcher.onError(finish);
          void observeCompletion();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

  private workspaceArchivedAt(workspaceId: string): string | null {
    const records = JSON.parse(
      readFileSync(path.join(this.paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; archivedAt?: string | null }>;
    return records.find((workspace) => workspace.workspaceId === workspaceId)?.archivedAt ?? null;
  }

  async worktreeState(worktreePath: string): Promise<{ exists: boolean; listed: boolean }> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      this.root,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const listedPaths = stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => this.comparablePath(line.slice("worktree ".length)));
    return {
      exists: existsSync(worktreePath),
      listed: listedPaths.includes(this.comparablePath(worktreePath)),
    };
  }

  async createBranch(branch: string): Promise<void> {
    await execFileAsync("git", ["-C", this.root, "branch", branch]);
  }

  async currentBranch(cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"]);
    return stdout.trim();
  }

  async ownedPermissionRequest(agentId: string) {
    const message = await this.latestSocket().socket.messageMatching(
      (candidate): candidate is HubExecutionAgentStream =>
        candidate.type === "hub.execution.agent.stream" &&
        candidate.payload.agentId === agentId &&
        candidate.payload.event.type === "permission_requested",
    );
    if (message.payload.event.type !== "permission_requested") {
      throw new Error(`Owned agent ${agentId} did not request permission`);
    }
    return message.payload.event.request;
  }

  async allowOwnedPermission(agentId: string, requestId: string): Promise<void> {
    await this.daemon!.agentManager.respondToPermission(agentId, requestId, { behavior: "allow" });
  }

  async listedWorktrees(): Promise<string[]> {
    const { stdout } = await execFileAsync("git", [
      "-C",
      this.root,
      "worktree",
      "list",
      "--porcelain",
    ]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  async createOwnedConcurrently(executionId = "execution-1"): Promise<{
    first: AcceptedCreate;
    duplicate: AcceptedCreate;
  }> {
    this.beginOwnedCreate("create-1", executionId);
    this.beginOwnedCreate("create-2", executionId);
    const first = await this.acceptedCreate("create-1");
    const duplicate = await this.acceptedCreate("create-2");
    return { first, duplicate };
  }

  async ownedUpdate(agentId: string): Promise<HubExecutionAgentUpdate["payload"]> {
    const message = await this.latestSocket().socket.messageMatching(
      (candidate): candidate is HubExecutionAgentUpdate =>
        candidate.type === "hub.execution.agent.update" && candidate.payload.agentId === agentId,
    );
    return message.payload;
  }

  async ownedRunningUpdate(agentId: string): Promise<HubExecutionAgentUpdate["payload"]> {
    const message = await this.latestSocket().socket.messageMatching(
      (candidate): candidate is HubExecutionAgentUpdate =>
        candidate.type === "hub.execution.agent.update" &&
        candidate.payload.agentId === agentId &&
        candidate.payload.agent.status === "running",
    );
    return message.payload;
  }

  async ownedTurnCompletion(agentId: string): Promise<HubExecutionAgentStream["payload"]> {
    const socket = this.latestSocket().socket;
    const completed = await socket.messageMatching(
      (candidate): candidate is HubExecutionAgentStream =>
        candidate.type === "hub.execution.agent.stream" &&
        candidate.payload.agentId === agentId &&
        candidate.payload.event.type === "turn_completed",
    );
    return completed.payload;
  }

  async ownedTurnFailure(agentId: string): Promise<HubExecutionAgentStream["payload"]> {
    const failed = await this.latestSocket().socket.messageMatching(
      (candidate): candidate is HubExecutionAgentStream =>
        candidate.type === "hub.execution.agent.stream" &&
        candidate.payload.agentId === agentId &&
        candidate.payload.event.type === "turn_failed",
    );
    return failed.payload;
  }

  latestOwnedTurnCompletions(agentId: string): number {
    return this.latestSocket().socket.sent.filter(
      (message) =>
        message.type === "hub.execution.agent.stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "turn_completed",
    ).length;
  }

  async ownedStream(agentId: string): Promise<HubExecutionAgentStream["payload"]> {
    const message = await this.latestSocket().socket.messageMatching(
      (candidate): candidate is HubExecutionAgentStream =>
        candidate.type === "hub.execution.agent.stream" && candidate.payload.agentId === agentId,
    );
    return message.payload;
  }

  async createUnrelatedLocalAgent(): Promise<string> {
    const agent = await this.daemon!.agentManager.createAgent(
      { provider: "codex", cwd: this.root },
      undefined,
      { workspaceId: "local-workspace" },
    );
    return agent.id;
  }

  async deniedSteering(agentId: string): Promise<RpcErrorMessage["payload"]> {
    const requestId = "denied-steer";
    this.latestSocket().socket.receive({
      type: "send_agent_message_request",
      requestId,
      agentId,
      text: "This must not run",
    });
    return ((await this.latestSocket().socket.messageFor(requestId)) as RpcErrorMessage).payload;
  }

  async deniedBrowserDispatch(): Promise<RpcErrorMessage["payload"]> {
    const requestId = "browser-1";
    this.latestSocket().socket.receive({
      type: "browser.automation.execute.response",
      payload: {
        requestId,
        ok: false,
        error: { code: "browser_denied", message: "denied", retryable: false },
      },
    });
    return ((await this.latestSocket().socket.messageFor(requestId)) as RpcErrorMessage).payload;
  }

  observedAgentIds(): string[] {
    return this.remote.sockets.flatMap(({ socket }) =>
      socket.sent.flatMap((message) => {
        if (message.type === "hub.execution.agent.update") return [message.payload.agentId];
        if (message.type === "hub.execution.agent.stream") return [message.payload.agentId];
        return [];
      }),
    );
  }

  observedTrustedLifecycleMessages(): string[] {
    return this.remote.sockets.flatMap(({ socket }) =>
      socket.sent
        .filter((message) => message.type === "status")
        .map((message) => message.payload.status),
    );
  }

  probeTrustedHello(): number | null {
    const socket = this.latestSocket().socket;
    socket.receiveEnvelope({
      type: "hello",
      clientId: "hub-must-not-resume",
      clientType: "browser",
      protocolVersion: 1,
      capabilities: { voice: true, pushNotifications: true },
    });
    return socket.closeCode;
  }

  probeBinaryFrame(): number | null {
    const socket = this.latestSocket().socket;
    socket.receiveBinary();
    return socket.closeCode;
  }

  async trustedBroadcastCount(): Promise<number> {
    const before = this.daemonConfigBroadcasts();
    const client = await this.trustedClient();
    try {
      await client.patchDaemonConfig({ appendSystemPrompt: "hub-broadcast-isolation" });
      this.beginOwnedCreate("broadcast-barrier", "broadcast-barrier");
      await this.acceptedCreate("broadcast-barrier");
      return this.daemonConfigBroadcasts() - before;
    } finally {
      await client.close();
    }
  }

  async trustedDaemonStatus() {
    const client = await this.trustedClient();
    try {
      return await client.getDaemonStatus();
    } finally {
      await client.close();
    }
  }

  async reconnectAndRetry(executionId = "execution-1") {
    this.closeLatestSocket(1006);
    await this.retry();
    this.connectLatestSocket();
    this.beginOwnedCreate("reconnect-retry", executionId);
    return this.acceptedCreate("reconnect-retry");
  }

  async reconstructAndReplay(executionId = "execution-1") {
    const storage = new AgentStorage(
      path.join(this.paseoHome, "agents"),
      pino({ level: "silent" }),
    );
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger: pino({ level: "silent" }),
    });
    const executions = this.executionsForReconstruction(manager, storage);
    const replay = await executions.create(this.ownedCreateInput(executionId));
    const durableAgentCount = (await storage.list()).filter(
      (record) => record.owner?.kind === "daemon",
    ).length;
    return { replay, durableAgentCount };
  }

  async removeOwnedAgent(agentId: string) {
    await this.daemon!.agentStorage.remove(agentId);
    const storage = new AgentStorage(
      path.join(this.paseoHome, "agents"),
      pino({ level: "silent" }),
    );
    return {
      durableAgentCount: (await storage.list()).filter((record) => record.owner?.kind === "daemon")
        .length,
    };
  }

  socketAttempts(): number {
    return this.remote.sockets.length;
  }

  revocationAttempts(): number {
    return this.remote.revocations.length;
  }

  latestRevocation(): HubRevocation | null {
    return this.remote.revocations.at(-1) ?? null;
  }

  enrollmentAttempts(): HubEnrollment[] {
    return this.remote.enrollments.map((input) => ({ ...input, scopes: input.scopes.slice() }));
  }

  enrollmentInvocation(index = 0): RelationshipInvocationSnapshot {
    const snapshot = this.remote.enrollmentSnapshots[index];
    if (!snapshot) throw new Error(`Enrollment invocation ${index} does not exist`);
    return snapshot;
  }

  socketInvocation(index = 0): RelationshipInvocationSnapshot {
    const snapshot = this.remote.socketSnapshots[index];
    if (!snapshot) throw new Error(`Socket invocation ${index} does not exist`);
    return snapshot;
  }

  enrolledRelationships(): number {
    return this.remote.relationshipCount();
  }

  loggableValues(status: Record<string, unknown>): string {
    return JSON.stringify({ status, logs: this.logs });
  }

  relationshipFile(): PersistedRelationship | null {
    const file = path.join(this.paseoHome, "hub-relationship.json");
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as PersistedRelationship;
  }

  relationshipFileMode(): number {
    return statSync(path.join(this.paseoHome, "hub-relationship.json")).mode & 0o777;
  }

  async corruptRelationshipFile(contents = "{not-json"): Promise<void> {
    await this.stopDaemon();
    await writeFile(path.join(this.paseoHome, "hub-relationship.json"), contents, "utf8");
  }

  async quarantinedRelationshipFiles(): Promise<string[]> {
    return (await readdir(this.paseoHome)).filter((file) =>
      file.startsWith("hub-relationship.invalid-"),
    );
  }

  async startStoppedDaemon(): Promise<void> {
    await this.startDaemon();
  }

  async storedOwnedStatus(agentId: string): Promise<string | null> {
    return (await this.daemon!.agentStorage.get(agentId))?.lastStatus ?? null;
  }

  private captureRelationship(): RelationshipInvocationSnapshot {
    const record = this.relationshipFile();
    if (!record) throw new Error("Relationship authority was not persisted before invocation");
    return { mode: this.relationshipFileMode(), record };
  }

  async retry(): Promise<void> {
    await this.clock.runNext();
  }

  async restartDaemon(): Promise<void> {
    await this.stopDaemon();
    await this.startDaemon();
  }

  async shutdownDaemon(): Promise<void> {
    await this.stopDaemon();
  }

  async close(): Promise<void> {
    await this.stopDaemon();
    await Promise.allSettled(this.cliProcesses);
    await Promise.all(
      [...this.claimedCliSockets].map((socket) => this.closeClaimedCliSocket(socket)),
    );
    await this.removeRoot();
  }

  private async createHome(): Promise<void> {
    this.root = await mkdtemp(path.join(tmpdir(), "paseo-hub-relationship-"));
    this.paseoHome = path.join(this.root, ".paseo");
    const staticDir = path.join(this.root, "static");
    await Promise.all([mkdir(this.paseoHome, { recursive: true }), mkdir(staticDir)]);
    execFileSync("git", ["init", "-b", "main", this.root], { stdio: "ignore" });
    execFileSync("git", ["-C", this.root, "config", "user.email", "hub@test.invalid"]);
    execFileSync("git", ["-C", this.root, "config", "user.name", "Hub Test"]);
    execFileSync("git", ["-C", this.root, "commit", "--allow-empty", "-m", "initial"], {
      stdio: "ignore",
    });
    this.config = {
      listen: "0.0.0.0:0",
      paseoHome: this.paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {
        ...createTestAgentClients(),
        codex: this.codex,
      },
      agentStoragePath: path.join(this.paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    };
  }

  private async startDaemon(): Promise<void> {
    const destination = new Writable({
      write: (chunk, _encoding, done) => {
        this.logs.push(String(chunk));
        done();
      },
    });
    this.daemon = await createPaseoDaemon(this.config, pino({ level: "trace" }, destination), {
      hubRelationshipRemote: this.remote,
      hubRelationshipClock: this.clock,
      hubRelationshipRetryPolicy: this.clock,
      createHubDaemonId: () => "daemon-test",
    });
    await this.daemon.start();
    const target = this.daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Daemon did not bind TCP");
    this.host = `127.0.0.1:${target.port}`;
  }

  private async stopDaemon(): Promise<void> {
    await this.daemon?.stop();
    this.daemon = null;
  }

  private runCli(args: string[]): Promise<Record<string, unknown>> {
    return this.trackCli(this.executeCli(args));
  }

  private async executeCli(args: string[]): Promise<Record<string, unknown>> {
    const entrypoint = path.join(import.meta.dirname, "../../test-utils/hub-cli-entry.ts");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        entrypoint,
        ...args,
        "--host",
        this.host,
        "--json",
      ],
      { cwd: REPOSITORY_ROOT, env: { ...process.env, NO_COLOR: "1" } },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed)) return parsed[0] as Record<string, unknown>;
    return parsed as Record<string, unknown>;
  }

  private trackCli<T>(process: Promise<T>): Promise<T> {
    this.cliProcesses.add(process);
    void process.then(
      () => this.cliProcesses.delete(process),
      () => this.cliProcesses.delete(process),
    );
    return process;
  }

  private nextSocketEnvelope(socket: WebSocket): Promise<{ message: SessionOutboundMessage }> {
    return new Promise((resolve, reject) => {
      socket.once("message", (data) => {
        try {
          resolve(JSON.parse(data.toString()) as { message: SessionOutboundMessage });
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
    });
  }

  private async openClaimedCliSocket(
    url: string,
    options: { origin?: string } = {},
  ): Promise<WebSocket> {
    const socket = new WebSocket(url, options);
    this.claimedCliSockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "external-claimed-cli",
        clientType: "cli",
        protocolVersion: 1,
      }),
    );
    await this.nextSocketEnvelope(socket);
    return socket;
  }

  private async closeClaimedCliSocket(socket: WebSocket): Promise<void> {
    this.claimedCliSockets.delete(socket);
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.terminate();
    await closed;
  }

  private comparablePath(value: string): string {
    const resolved = path.resolve(value);
    let canonical = resolved;
    try {
      canonical = realpathSync.native(resolved);
    } catch {
      // An archived worktree no longer exists, so compare its normalized target path.
    }
    const normalized = path.normalize(canonical);
    return platform() === "win32" ? normalized.toLowerCase() : normalized;
  }

  private async removeRoot(): Promise<void> {
    let retryableCode: string | null = null;
    if (platform() === "win32") retryableCode = "EBUSY";
    if (platform() === "darwin") retryableCode = "ENOTEMPTY";
    const attempts = retryableCode ? 10 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await rm(this.root, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== retryableCode || attempt === attempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  private latestSocket(): SocketAttempt {
    const socket = this.remote.sockets.at(-1);
    if (!socket) throw new Error("No Hub socket has been opened");
    return socket;
  }

  private async acceptedCreate(requestId: string): Promise<AcceptedCreate> {
    const message = (await this.latestSocket().socket.messageFor(
      requestId,
    )) as HubExecutionAgentCreateResponse;
    if (!message.payload.success || !message.payload.agentId || !message.payload.agent) {
      throw new Error(message.payload.error ?? "Hub agent creation failed");
    }
    return {
      ...message.payload,
      success: true,
      agentId: message.payload.agentId,
      agent: message.payload.agent,
    };
  }

  private ownedCreateInput(executionId: string) {
    return {
      executionId,
      provider: "codex",
      cwd: this.root,
      workspaceId: "hub-workspace",
      prompt: "Create through the Hub",
    };
  }

  private executionsForReconstruction(manager: AgentManager, storage: AgentStorage) {
    return new DaemonExecutions({
      daemonId: this.relationshipFile()!.relationship.daemonId,
      agentManager: manager,
      agentStorage: storage,
      createAgent: (input) =>
        createAgentCommand(
          {
            agentManager: manager,
            agentStorage: storage,
            logger: pino({ level: "silent" }),
            providerSnapshotManager: providerCatalog,
          },
          input,
        ),
    });
  }

  private async trustedClient(): Promise<DaemonClient> {
    const client = new DaemonClient({
      url: `ws://${this.host}/ws`,
      appVersion: "0.1.106",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "hub-relationship-trusted" } });
    return client;
  }

  private daemonConfigBroadcasts(): number {
    return this.remote.sockets
      .flatMap(({ socket }) => socket.sent)
      .filter(
        (message) =>
          message.type === "status" && message.payload.status === "daemon_config_changed",
      ).length;
  }
}
