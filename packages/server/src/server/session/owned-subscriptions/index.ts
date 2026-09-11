import { isReply } from "./replies.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

interface Source {
  socket: object;
  modern: boolean;
  active: boolean;
  handshakePending: boolean;
  cancellation: AbortController;
  subscriptions: Map<string, SubscriptionOwner>;
  operations: Set<RetainedOwner>;
}
interface DeliveryOwner {
  source: Source;
  active: boolean;
}
interface RequestOwner extends DeliveryOwner {
  request: SessionInboundMessage;
}
interface RetainedOwner extends DeliveryOwner {
  cancellation: AbortController;
  stop(): void | Promise<void>;
  forget(): void;
  release?: Promise<void>;
}
interface SubscriptionOwner extends RetainedOwner {
  id: string;
  family: string;
  legacySlot: string;
  responseId: string;
}

export interface OwnedOperation {
  readonly source: object;
  readonly signal: AbortSignal;
  emit(message: SessionOutboundMessage): void;
  release(): Promise<void>;
}

export interface OwnedSubscription {
  readonly id: string;
  readonly responseId: string;
  readonly source: object;
  readonly signal: AbortSignal;
  emit(message: SessionOutboundMessage): void;
  emitBinary(frame: Uint8Array): void;
  release(): Promise<void>;
}

/** Source provenance and lifetimes. Domain producers own snapshots, filters and buffering. */
export class SessionDelivery {
  private readonly requests = new AsyncLocalStorage<RequestOwner>();
  private readonly projectionSource = new AsyncLocalStorage<object>();
  private readonly sources = new Map<object, Source>();
  private readonly proofs = new WeakMap<object, DeliveryOwner>();
  private readonly defaultSource = {};

  constructor(
    private readonly send: (source: object, message: SessionOutboundMessage) => void,
    private readonly sendBinary: (source: object, frame: Uint8Array) => void = () => {},
    private readonly project: (
      source: object,
      message: SessionOutboundMessage,
    ) => SessionOutboundMessage = (_source, message) => message,
    private readonly unexpectedReply: (
      request: SessionInboundMessage,
      message: SessionOutboundMessage,
    ) => void = () => {},
  ) {}

  attach(socket: object, modern: boolean): void {
    const existing = this.sources.get(socket);
    if (existing) {
      if (existing.modern !== modern)
        throw new Error("Cannot renegotiate subscription ownership on an active source");
      return;
    }
    this.sources.set(socket, {
      socket,
      modern,
      active: true,
      handshakePending: true,
      cancellation: new AbortController(),
      subscriptions: new Map(),
      operations: new Set(),
    });
  }

  get currentSource(): object | undefined {
    return this.projectionSource.getStore() ?? this.requests.getStore()?.source.socket;
  }

  get requestSignal(): AbortSignal {
    const request = this.requests.getStore();
    if (!request) throw new Error("Operation has no requesting source");
    return request.source.cancellation.signal;
  }

  forSource<T>(source: object, project: () => T): T {
    return this.projectionSource.run(source, project);
  }

  hasLegacySources(): boolean {
    return [...this.sources.values()].some((source) => source.active && !source.modern);
  }

  hasDemand(family: string): boolean {
    return [...this.sources.values()].some(
      (source) =>
        source.active &&
        [...source.subscriptions.values()].some((owner) => owner.active && owner.family === family),
    );
  }

  subscriptionIds(source: object, family: string): string[] {
    return [...(this.sources.get(source)?.subscriptions.values() ?? [])]
      .filter((owner) => owner.active && owner.family === family)
      .map((owner) => owner.id);
  }

  get registrationCount(): number {
    return [...this.sources.values()].reduce(
      (count, source) => count + source.subscriptions.size + source.operations.size,
      0,
    );
  }

  sourceRegistrationCount(socket = this.currentSource): number {
    const source = socket ? this.sources.get(socket) : undefined;
    return source ? source.subscriptions.size + source.operations.size : 0;
  }

  async releaseFamily(family: string): Promise<void> {
    await Promise.all(
      [...this.sources.values()].flatMap((source) =>
        [...source.subscriptions.values()]
          .filter((owner) => owner.family === family)
          .map((owner) => this.releaseOwner(owner)),
      ),
    );
  }

  isModern(socket: object | undefined): boolean {
    return socket ? this.sources.get(socket)?.modern === true : false;
  }

  async detach(socket: object): Promise<void> {
    const source = this.sources.get(socket);
    if (!source) return;
    source.active = false;
    source.cancellation.abort();
    await Promise.all(
      [...source.subscriptions.values(), ...source.operations].map((owner) =>
        this.releaseOwner(owner),
      ),
    );
    this.sources.delete(socket);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sources.keys()].map((socket) => this.detach(socket)));
  }

  async request(
    socket: object | undefined,
    request: SessionInboundMessage,
    run: () => Promise<void>,
  ): Promise<void> {
    socket ??= this.defaultSource;
    if (!this.sources.has(socket)) this.attach(socket, false);
    const source = this.sources.get(socket)!;
    const owner: RequestOwner = { source, request, active: true };
    try {
      await this.requests.run(owner, run);
    } finally {
      owner.active = false;
    }
  }

  protocolFailure(
    socket: object,
    failure: {
      requestId?: string;
      requestType?: string;
      error: string;
      code: "invalid_message" | "unknown_schema";
    },
  ): void {
    const source = this.sources.get(socket);
    if (!source?.active) return;
    const message: SessionOutboundMessage =
      failure.requestId !== undefined
        ? { type: "rpc_error", payload: { ...failure, requestId: failure.requestId } }
        : { type: "status", payload: { status: "error", message: failure.error } };
    const owner: DeliveryOwner = { source, active: true };
    try {
      this.sendOwned(owner, message);
    } finally {
      owner.active = false;
    }
  }

  authorizeReply(message: SessionOutboundMessage, socket: object): SessionOutboundMessage {
    message = this.project(socket, message);
    const owner = this.requests.getStore();
    if (owner?.active && owner.source.socket === socket && isReply(owner.request, message))
      this.proofs.set(message, owner);
    return message;
  }

  reply(message: SessionOutboundMessage): boolean {
    const owner = this.requests.getStore();
    if (!owner?.active) return false;
    if (!isReply(owner.request, message)) {
      if (
        "requestId" in owner.request &&
        "payload" in message &&
        "requestId" in message.payload &&
        message.payload.requestId === owner.request.requestId
      ) {
        this.unexpectedReply(owner.request, message);
      }
      return false;
    }
    const reply = owner.source.modern ? message : legacyMessage(message);
    this.sendOwned(owner, reply);
    return true;
  }

  begin(
    family: string,
    requestedId: string | undefined,
    stop: (id: string) => void | Promise<void>,
    legacySlot = family,
  ): OwnedSubscription {
    const request = this.requests.getStore();
    if (!request?.active || !request.source.active)
      throw new Error("Subscription source is closed");
    const source = request.source;
    if (source.modern && (!("requestId" in request.request) || !request.request.requestId))
      throw new Error("Owned subscriptions require a requestId");
    if (source.modern && requestedId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09 once client floor >= v0.8.0.
    if (!source.modern) {
      for (const prior of source.subscriptions.values()) {
        // Keep failed teardown registered so disconnect/close can report it.
        if (prior.legacySlot === legacySlot) void this.releaseOwner(prior).catch(() => {});
      }
    }
    const id = randomUUID();
    const responseId = source.modern ? id : requestedId?.trim() || id;
    const owner: SubscriptionOwner = {
      id,
      responseId,
      source,
      family,
      legacySlot,
      active: true,
      cancellation: new AbortController(),
      stop: () => stop(id),
      forget: () => {
        source.subscriptions.delete(id);
      },
    };
    source.subscriptions.set(id, owner);
    return {
      id,
      responseId,
      source: source.socket,
      signal: owner.cancellation.signal,
      emit: (message) => {
        if (!owner.active || !source.active) return;
        const tagged =
          source.modern ||
          message.type === "fs.file.update" ||
          message.type === "checkout_diff_update"
            ? withSubscriptionId(message, responseId)
            : legacyMessage(message);
        this.sendOwned(owner, tagged);
      },
      emitBinary: (frame) => {
        if (!owner.active || !source.active) return;
        this.proofs.set(frame, owner);
        this.sendBinary(source.socket, frame);
      },
      release: () => this.releaseOwner(owner),
    };
  }

  /** A domain extends the originating request until its asynchronous operation ends. */
  operation(
    accepts: (message: SessionOutboundMessage) => boolean,
    stop: () => void | Promise<void>,
  ): OwnedOperation {
    const request = this.requests.getStore();
    if (!request?.active || !request.source.active) throw new Error("Operation source is closed");
    const source = request.source;
    const owner: RetainedOwner = {
      source,
      active: true,
      cancellation: new AbortController(),
      stop,
      forget: () => {
        source.operations.delete(owner);
      },
    };
    source.operations.add(owner);
    return {
      source: source.socket,
      signal: owner.cancellation.signal,
      emit: (message) => {
        if (!owner.active || !source.active || !accepts(message)) return;
        this.sendOwned(owner, message);
      },
      release: () => this.releaseOwner(owner),
    };
  }

  async release(id: string): Promise<void> {
    const source = this.requests.getStore()?.source;
    const owner =
      source?.subscriptions.get(id) ??
      (source && !source.modern
        ? [...source.subscriptions.values()].find((candidate) => candidate.responseId === id)
        : undefined);
    if (owner) await this.releaseOwner(owner);
  }

  async releaseLegacySlot(slot: string): Promise<void> {
    const source = this.requests.getStore()?.source;
    if (!source) return;
    if (source.modern)
      throw new Error("Release subscriptions using the server-assigned subscription ID");
    const owner = [...source.subscriptions.values()].find(
      (candidate) => candidate.legacySlot === slot,
    );
    if (owner) await this.releaseOwner(owner);
  }

  authorizeFileReply(frame: Uint8Array, socket: object): void {
    const owner = this.requests.getStore();
    if (
      owner?.active &&
      owner.source.socket === socket &&
      owner.request.type === "file_explorer_request"
    )
      this.proofs.set(frame, owner);
  }

  permitsBinary(socket: object, frame: Uint8Array): boolean {
    const source = this.sources.get(socket);
    if (!source?.active) return false;
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09 once client floor >= v0.8.0.
    if (!source.modern) return true;
    const owner = this.proofs.get(frame);
    return owner?.active === true && owner.source === source;
  }

  permits(socket: object, message: SessionOutboundMessage): boolean {
    const source = this.sources.get(socket);
    if (!source?.active) return false;
    // COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09 once client floor >= v0.8.0.
    if (!source.modern) return true;
    if (
      message.type === "status" &&
      message.payload.status === "server_info" &&
      source.handshakePending
    ) {
      source.handshakePending = false;
      return true;
    }
    const owner = this.proofs.get(message);
    return owner?.active === true && owner.source === source;
  }

  private sendOwned(owner: DeliveryOwner, message: SessionOutboundMessage): void {
    const projected = this.project(owner.source.socket, message);
    this.proofs.set(projected, owner);
    this.send(owner.source.socket, projected);
  }

  private releaseOwner(owner: RetainedOwner): Promise<void> {
    if (owner.release) return owner.release;
    owner.active = false;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    owner.release = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    owner.cancellation.abort();
    try {
      void Promise.resolve(owner.stop()).then(() => {
        owner.forget();
        resolve();
        return undefined;
      }, reject);
    } catch (error) {
      reject(error);
    }
    return owner.release;
  }
}

function withSubscriptionId<T extends SessionOutboundMessage>(
  message: T,
  subscriptionId: string,
): T {
  return "payload" in message
    ? { ...message, payload: { ...message.payload, subscriptionId } }
    : { ...message, subscriptionId };
}

// COMPAT(ownedSubscriptions): added in v0.8.0, remove after 2027-03-09 once client floor >= v0.8.0.
function legacyMessage(message: SessionOutboundMessage): SessionOutboundMessage {
  if (message.type === "terminals_changed") {
    const { workspaceId: _workspaceId, ...payload } = message.payload;
    return { ...message, payload };
  }
  if (
    message.type !== "subscribe_terminal_response" &&
    message.type !== "session.events.set_subscription.response" &&
    message.type !== "agent.timeline.set_subscription.response" &&
    message.type !== "workspace.label.list.response"
  )
    return message;
  if (!("subscriptionId" in message.payload)) return message;
  const { subscriptionId: _subscriptionId, ...payload } = message.payload;
  return { ...message, payload } as SessionOutboundMessage;
}
