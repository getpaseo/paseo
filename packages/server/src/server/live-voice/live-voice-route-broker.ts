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
const DEFAULT_ROUTE_CIRCUIT_COOLDOWN_MS = 30_000;

type VoiceLiveRouteSuccessPayload = Extract<VoiceLiveRouteResponse["payload"], { ok: true }>;

export type LiveVoiceRouteResult = VoiceLiveRouteSuccessPayload["result"];

/**
 * A routed request that came back `ok: false`, with the wire error's code kept
 * on the exception. The fan-out tools read the code to tell "could not reach
 * that machine" from "that machine answered and the tool failed there" — two
 * things a voice call must narrate differently. Timeouts and send failures stay
 * plain Errors: no response ever arrived, so there is no code to carry.
 */
export class LiveVoiceRoutedRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean | undefined;

  constructor(message: string, options: { code: string; retryable?: boolean | undefined }) {
    super(message);
    this.name = "LiveVoiceRoutedRequestError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/**
 * One routed operation's lifecycle, reported to whoever registered the route.
 * `start` fires when the model's tool call has fully materialized — its
 * arguments are complete — which is the only external timestamp that brackets
 * the opaque model-side time (turn detection, thinking, argument generation).
 */
export interface LiveVoiceRouteObservation {
  phase: "start" | "end";
  requestId: string;
  operation: VoiceLiveRouteOperation;
  /** Set on `end`. */
  durationMs?: number;
  ok?: boolean;
  errorCode?: string;
}

export interface LiveVoiceRouteRegistration {
  hostAgentId: string;
  liveSessionId: string;
  sourceKey: object;
  send: (request: VoiceLiveRouteRequest) => void | Promise<void>;
  /** Timing diagnostics only. Errors here are swallowed; routing never depends on it. */
  observer?: (observation: LiveVoiceRouteObservation) => void;
}

export interface LiveVoiceRouteBrokerOptions {
  defaultTimeoutMs?: number;
  circuitCooldownMs?: number;
  createRequestId?: () => string;
  now?: () => number;
}

interface RegisteredLiveVoiceRoute extends LiveVoiceRouteRegistration {
  registrationId: number;
  circuitOpenUntil: number;
  active: boolean;
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
 * Routes the hidden Live Voice host's MCP tools back through the authenticated,
 * reconnectable app session that owns the call. Socket replacement preserves
 * the route during the bounded reconnect grace.
 */
export class LiveVoiceRouteBroker {
  private readonly defaultTimeoutMs: number;
  private readonly circuitCooldownMs: number;
  private readonly createRequestId: () => string;
  private readonly now: () => number;
  private readonly routesByHostAgentId = new Map<string, RegisteredLiveVoiceRoute>();
  private readonly pendingByRequestId = new Map<string, PendingLiveVoiceRoute>();
  private registrationSequence = 0;

  constructor(options: LiveVoiceRouteBrokerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    this.circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_ROUTE_CIRCUIT_COOLDOWN_MS;
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.now = options.now ?? Date.now;
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
      circuitOpenUntil: 0,
      active: true,
    };
    this.routesByHostAgentId.set(registration.hostAgentId, registered);
    return () => this.deactivate(registration.hostAgentId, registered.registrationId);
  }

  isRegisteredHost(hostAgentId: string): boolean {
    return this.routesByHostAgentId.has(hostAgentId);
  }

  /** Remove the hidden-host classification after its agent is fully disposed. */
  releaseHost(hostAgentId: string): void {
    this.routesByHostAgentId.delete(hostAgentId);
  }

  async execute(
    hostAgentId: string,
    operation: VoiceLiveRouteOperation,
    options: { timeoutMs?: number } = {},
  ): Promise<LiveVoiceRouteResult> {
    const route = this.routesByHostAgentId.get(hostAgentId);
    if (!route || !route.active) {
      throw new Error("This Live Voice call is no longer connected to its owning client.");
    }
    if (route.circuitOpenUntil > this.now()) {
      throw new LiveVoiceRoutedRequestError(
        "The owning app is not responding to Live Voice routing. Try again after Paseo returns to the foreground.",
        { code: "router_unavailable", retryable: false },
      );
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
    this.observe(route, { phase: "start", requestId, operation });
    const startedAt = this.now();

    const resultPromise = new Promise<LiveVoiceRouteResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingByRequestId.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingByRequestId.delete(requestId);
        route.circuitOpenUntil = this.now() + this.circuitCooldownMs;
        pending.reject(
          new LiveVoiceRoutedRequestError(
            "Timed out waiting for the owning client to route this request.",
            { code: "router_timeout", retryable: true },
          ),
        );
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

    // Observation rides a side chain so a throwing observer can never disturb
    // the result the caller awaits.
    void resultPromise
      .then(
        () =>
          this.observe(route, {
            phase: "end",
            requestId,
            operation,
            durationMs: this.now() - startedAt,
            ok: true,
          }),
        (error) =>
          this.observe(route, {
            phase: "end",
            requestId,
            operation,
            durationMs: this.now() - startedAt,
            ok: false,
            errorCode:
              error instanceof LiveVoiceRoutedRequestError ? error.code : "router_request_failed",
          }),
      )
      .catch(() => undefined);

    try {
      await route.send(parsedRequest.data);
    } catch (error) {
      route.circuitOpenUntil = this.now() + this.circuitCooldownMs;
      this.rejectPending(
        requestId,
        new LiveVoiceRoutedRequestError(
          `Could not send the Live Voice route request: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: "router_send_failed", retryable: true },
        ),
      );
    }
    return await resultPromise;
  }

  private observe(route: RegisteredLiveVoiceRoute, observation: LiveVoiceRouteObservation): void {
    try {
      route.observer?.(observation);
    } catch {
      // Diagnostics must never break routing.
    }
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
    const route = this.routesByHostAgentId.get(pending.hostAgentId);
    if (route?.sourceKey === sourceKey && route.liveSessionId === pending.liveSessionId) {
      route.circuitOpenUntil = 0;
    }
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(
        new LiveVoiceRoutedRequestError(payload.error.message, {
          code: payload.error.code,
          retryable: payload.error.retryable,
        }),
      );
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

  private deactivate(hostAgentId: string, registrationId: number): void {
    const current = this.routesByHostAgentId.get(hostAgentId);
    if (!current || current.registrationId !== registrationId) {
      return;
    }
    current.active = false;
    for (const [requestId, pending] of this.pendingByRequestId) {
      if (pending.hostAgentId === hostAgentId) {
        this.rejectPending(
          requestId,
          new LiveVoiceRoutedRequestError(
            "The Live Voice call closed before its routed request completed.",
            { code: "route_closed", retryable: false },
          ),
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
