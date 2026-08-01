import { randomUUID } from "node:crypto";
import {
  VoiceLiveRouteRequestSchema,
  VoiceLiveRouteResponseSchema,
  type VoiceLiveRouteOperation,
  type VoiceLiveRouteRequest,
  type VoiceLiveRouteResponse,
} from "@getpaseo/protocol/live-voice-routing";

// Matches the owning app's target-daemon execution timeout. Some ordinary Paseo
// tools wait for an agent turn, so this cannot use the short interactive RPC
// timeout used by browser automation.
const DEFAULT_ROUTE_TIMEOUT_MS = 10 * 60_000;

type VoiceLiveRouteSuccessPayload = Extract<VoiceLiveRouteResponse["payload"], { ok: true }>;

export type LiveVoiceRouteResult = VoiceLiveRouteSuccessPayload["result"];

export interface LiveVoiceRouteRegistration {
  hostAgentId: string;
  liveSessionId: string;
  sourceKey: object;
  send: (request: VoiceLiveRouteRequest) => void | Promise<void>;
}

export interface LiveVoiceRouteBrokerOptions {
  defaultTimeoutMs?: number;
  createRequestId?: () => string;
}

interface RegisteredLiveVoiceRoute extends LiveVoiceRouteRegistration {
  registrationId: number;
}

interface PendingLiveVoiceRoute {
  hostAgentId: string;
  liveSessionId: string;
  sourceKey: object;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: LiveVoiceRouteResult) => void;
  reject: (error: Error) => void;
}

/**
 * Routes the hidden Live Voice host's two MCP tools back through the exact app
 * socket that owns the call. A logical client session can have multiple sockets,
 * so neither clientId nor the shared Session object is a sufficient authority.
 */
export class LiveVoiceRouteBroker {
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly routesByHostAgentId = new Map<string, RegisteredLiveVoiceRoute>();
  private readonly pendingByRequestId = new Map<string, PendingLiveVoiceRoute>();
  private registrationSequence = 0;

  constructor(options: LiveVoiceRouteBrokerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? randomUUID;
  }

  register(registration: LiveVoiceRouteRegistration): () => void {
    if (this.routesByHostAgentId.has(registration.hostAgentId)) {
      throw new Error(
        `Live Voice routing is already registered for host agent ${registration.hostAgentId}`,
      );
    }
    const registered: RegisteredLiveVoiceRoute = {
      ...registration,
      registrationId: ++this.registrationSequence,
    };
    this.routesByHostAgentId.set(registration.hostAgentId, registered);
    return () => this.unregister(registration.hostAgentId, registered.registrationId);
  }

  isRegisteredHost(hostAgentId: string): boolean {
    return this.routesByHostAgentId.has(hostAgentId);
  }

  async execute(
    hostAgentId: string,
    operation: VoiceLiveRouteOperation,
    options: { timeoutMs?: number } = {},
  ): Promise<LiveVoiceRouteResult> {
    const route = this.routesByHostAgentId.get(hostAgentId);
    if (!route) {
      throw new Error("This Live Voice call is no longer connected to its owning client.");
    }

    const requestId = this.createUniqueRequestId();
    const parsedRequest = VoiceLiveRouteRequestSchema.safeParse({
      type: "voice.live.route.request",
      requestId,
      liveSessionId: route.liveSessionId,
      operation,
    });
    if (!parsedRequest.success) {
      throw new Error(
        `Invalid Live Voice route request: ${parsedRequest.error.issues[0]?.message ?? "unknown validation error"}`,
      );
    }

    const resultPromise = new Promise<LiveVoiceRouteResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingByRequestId.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingByRequestId.delete(requestId);
        pending.reject(new Error("Timed out waiting for the owning client to route this request."));
      }, options.timeoutMs ?? this.defaultTimeoutMs);
      timeout.unref?.();
      this.pendingByRequestId.set(requestId, {
        hostAgentId,
        liveSessionId: route.liveSessionId,
        sourceKey: route.sourceKey,
        timeout,
        resolve,
        reject,
      });
    });

    try {
      await route.send(parsedRequest.data);
    } catch (error) {
      this.rejectPending(
        requestId,
        new Error(
          `Could not send the Live Voice route request: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
    return await resultPromise;
  }

  /**
   * Returns true only when the response completed a request. Wrong-source,
   * wrong-call, malformed, duplicate, and late responses are ignored without
   * disturbing the real pending request.
   */
  receiveResponse(response: VoiceLiveRouteResponse, sourceKey: object): boolean {
    const parsed = VoiceLiveRouteResponseSchema.safeParse(response);
    if (!parsed.success) {
      return false;
    }
    const payload = parsed.data.payload;
    const pending = this.pendingByRequestId.get(payload.requestId);
    if (
      !pending ||
      pending.sourceKey !== sourceKey ||
      pending.liveSessionId !== payload.liveSessionId
    ) {
      return false;
    }

    this.pendingByRequestId.delete(payload.requestId);
    clearTimeout(pending.timeout);
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(payload.error.message));
    }
    return true;
  }

  getPendingRequestCount(): number {
    return this.pendingByRequestId.size;
  }

  private createUniqueRequestId(): string {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const requestId = this.createRequestId();
      if (!this.pendingByRequestId.has(requestId)) {
        return requestId;
      }
    }
    throw new Error("Could not allocate a unique Live Voice route request id.");
  }

  private unregister(hostAgentId: string, registrationId: number): void {
    const current = this.routesByHostAgentId.get(hostAgentId);
    if (!current || current.registrationId !== registrationId) {
      return;
    }
    this.routesByHostAgentId.delete(hostAgentId);
    for (const [requestId, pending] of this.pendingByRequestId) {
      if (pending.hostAgentId === hostAgentId) {
        this.rejectPending(
          requestId,
          new Error("The Live Voice call closed before its routed request completed."),
        );
      }
    }
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingByRequestId.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}
