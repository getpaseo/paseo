import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInboundMessage, SessionOutboundMessage } from "@server/server/messages";
import type { UseWebSocketReturn } from "./use-websocket";
import { generateMessageId } from "@/types/stream";

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_JITTER_MS = 250;

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  return new Error("Unexpected RPC error");
};

type RequestType = SessionInboundMessage["type"];
type ResponseType = SessionOutboundMessage["type"];

type RequestOf<TType extends RequestType> = Extract<SessionInboundMessage, { type: TType }>;
type ResponseOf<TType extends ResponseType> = Extract<SessionOutboundMessage, { type: TType }>;

type RpcState<T> =
  | { status: "idle"; requestId: null }
  | { status: "loading"; requestId: string }
  | { status: "success"; requestId: string; data: T }
  | { status: "error"; requestId: string | null; error: Error };

type ResponseWithEnvelope<TType extends ResponseType> = Extract<
  ResponseOf<TType>,
  { payload: { requestId?: string } }
>;

type EnsureEnvelope<TType extends ResponseType> = ResponseWithEnvelope<TType> extends never ? never : TType;

type ResponsePayload<TType extends ResponseType> = ResponseWithEnvelope<TType> extends { payload: infer P }
  ? P
  : never;

type SelectResponse<TType extends ResponseType, TData> = (message: ResponseWithEnvelope<TType>) => TData;

type DispatchRequest<TType extends RequestType> = (request: RequestOf<TType>) => void | Promise<void>;

type DispatchOverride = (requestId: string, attempt: number) => void | Promise<void>;

export type RpcFailureReason = "dispatch" | "timeout" | "response" | "disconnected";

export interface RpcRetryContext {
  requestId: string;
  attempt: number;
  maxAttempts: number;
  reason: RpcFailureReason;
  error: Error;
}

export interface RpcRetryAttemptEvent extends RpcRetryContext {
  nextDelayMs: number;
}

export interface RpcRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterMs?: number;
  shouldRetry?: (context: RpcRetryContext) => boolean;
  onRetryAttempt?: (event: RpcRetryAttemptEvent) => void;
}

export class RpcRequestError extends Error {
  public readonly reason: RpcFailureReason;
  public readonly attempt: number;
  public readonly maxAttempts: number;
  public readonly requestId: string | null;

  constructor(message: string, options: { reason: RpcFailureReason; attempt: number; maxAttempts: number; requestId?: string | null; cause?: unknown }) {
    super(message);
    this.name = "RpcRequestError";
    this.reason = options.reason;
    this.attempt = options.attempt;
    this.maxAttempts = options.maxAttempts;
    this.requestId = options.requestId ?? null;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterMs: number;
  shouldRetry: NonNullable<RpcRetryOptions["shouldRetry"]>;
  onRetryAttempt?: RpcRetryOptions["onRetryAttempt"];
}

const resolveRetryOptions = (retry: RpcRetryOptions | undefined, canRetry: boolean): ResolvedRetryOptions => {
  const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
  const resolved: ResolvedRetryOptions = {
    maxAttempts: canRetry ? maxAttempts : 1,
    baseDelayMs: retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    backoffFactor: retry?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
    jitterMs: retry?.jitterMs ?? DEFAULT_JITTER_MS,
    shouldRetry: retry?.shouldRetry ?? (() => true),
    onRetryAttempt: retry?.onRetryAttempt,
  };
  return resolved;
};

const computeDelayMs = (attempt: number, options: ResolvedRetryOptions): number => {
  const exponential = options.baseDelayMs * options.backoffFactor ** Math.max(0, attempt - 1);
  const capped = Math.min(options.maxDelayMs, exponential);
  if (options.jitterMs <= 0) {
    return capped;
  }
  const jitter = Math.floor(Math.random() * options.jitterMs);
  return capped + jitter;
};

type WaitForResponseOptions = {
  requestId: string;
  dispatch?: DispatchOverride;
  retry?: RpcRetryOptions;
  timeoutMs?: number | null;
};

type SendOptions = {
  retry?: RpcRetryOptions;
  timeoutMs?: number | null;
};

type UseSessionRpcReturn<TRequest extends RequestType, TData> = {
  state: RpcState<TData>;
  send: (params: Omit<RequestOf<TRequest>, "type" | "requestId">, options?: SendOptions) => Promise<TData>;
  waitForResponse: (options: WaitForResponseOptions) => Promise<TData>;
  reset: () => void;
};

export function useSessionRpc<
  TRequest extends RequestType,
  TResponse extends ResponseType,
  TData = ResponsePayload<TResponse>
>(options: {
  ws: UseWebSocketReturn;
  requestType: TRequest;
  responseType: EnsureEnvelope<TResponse>;
  select?: SelectResponse<TResponse, TData>;
  dispatch?: DispatchRequest<TRequest>;
}): UseSessionRpcReturn<TRequest, TData> {
  const { ws, requestType, responseType, select, dispatch } = options;
  const [state, setState] = useState<RpcState<TData>>({ status: "idle", requestId: null });
  const activeRequestIdRef = useRef<string | null>(null);
  const resolveRef = useRef<((value: TData) => void) | null>(null);
  const rejectRef = useRef<((error: Error) => void) | null>(null);
  const dispatchRef = useRef<DispatchRequest<TRequest> | undefined>(dispatch);
  const timeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryOptionsRef = useRef<ResolvedRetryOptions | null>(null);
  const failureHandlerRef = useRef<((reason: RpcFailureReason, error: Error) => void) | null>(null);
  const currentAttemptRef = useRef(0);

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const clearTimeoutHandle = useCallback(() => {
    if (timeoutHandleRef.current) {
      clearTimeout(timeoutHandleRef.current);
      timeoutHandleRef.current = null;
    }
  }, []);

  const clearActiveRequest = useCallback(() => {
    clearTimeoutHandle();
    activeRequestIdRef.current = null;
    resolveRef.current = null;
    rejectRef.current = null;
    retryOptionsRef.current = null;
    failureHandlerRef.current = null;
    currentAttemptRef.current = 0;
  }, [clearTimeoutHandle]);

  useEffect(() => {
    return () => {
      clearActiveRequest();
    };
  }, [clearActiveRequest]);

  useEffect(() => {
    const unsubscribe = ws.on(responseType, (message) => {
      const typedMessage = message as ResponseWithEnvelope<TResponse>;
      const payload = typedMessage.payload;
      const expectedId = activeRequestIdRef.current;
      if (!payload || !expectedId || payload.requestId !== expectedId) {
        return;
      }

      clearTimeoutHandle();

      const payloadError =
        payload && typeof payload === "object" && "error" in payload && typeof (payload as any).error === "string"
          ? ((payload as any).error as string)
          : null;
      if (payloadError) {
        const error = new Error(payloadError);
        failureHandlerRef.current?.("response", error);
        return;
      }

      const baseData = typedMessage.payload as ResponsePayload<TResponse>;
      const data = select ? select(typedMessage) : (baseData as unknown as TData);
      setState({ status: "success", requestId: payload.requestId ?? null, data });
      resolveRef.current?.(data);
      clearActiveRequest();
    });

    return () => {
      unsubscribe();
    };
  }, [clearActiveRequest, clearTimeoutHandle, responseType, select, ws]);

  useEffect(() => {
    if (ws.subscribeConnectionStatus) {
      return ws.subscribeConnectionStatus((status) => {
        if (status.isConnected || !activeRequestIdRef.current || !failureHandlerRef.current) {
          return;
        }
        failureHandlerRef.current("disconnected", new Error("WebSocket disconnected"));
      });
    }
    if (!ws.isConnected && activeRequestIdRef.current && failureHandlerRef.current) {
      failureHandlerRef.current("disconnected", new Error("WebSocket disconnected"));
    }
  }, [ws.isConnected, ws.subscribeConnectionStatus]);

  const waitForResponse = useCallback(
    ({ requestId, dispatch: dispatchOverride, retry, timeoutMs = null }: WaitForResponseOptions) => {
      return new Promise<TData>((resolve, reject) => {
        const finalDispatch = dispatchOverride ?? null;
        const canRetry = typeof finalDispatch === "function";
        const resolvedRetry = resolveRetryOptions(retry, canRetry);

        activeRequestIdRef.current = requestId;
        resolveRef.current = (value) => {
          resolve(value);
        };
        rejectRef.current = (error) => {
          reject(error);
          clearActiveRequest();
        };
        retryOptionsRef.current = resolvedRetry;
        setState({ status: "loading", requestId });

        const finalizeError = (reason: RpcFailureReason, error: Error, attempt: number) => {
          const rpcError = new RpcRequestError(error.message, {
            reason,
            attempt,
            maxAttempts: resolvedRetry.maxAttempts,
            requestId,
            cause: error,
          });
          setState({ status: "error", requestId, error: rpcError });
          rejectRef.current?.(rpcError);
        };

        const scheduleAttempt = (attemptNumber: number) => {
          currentAttemptRef.current = attemptNumber;

          const runDispatch = async () => {
            if (!ws.isConnected) {
              throw new Error("WebSocket is disconnected");
            }

            if (finalDispatch) {
              await finalDispatch(requestId, attemptNumber);
            }

            if (timeoutMs !== null) {
              clearTimeoutHandle();
              timeoutHandleRef.current = setTimeout(() => {
                failureHandlerRef.current?.("timeout", new Error("RPC request timed out"));
              }, timeoutMs);
            }
          };

          runDispatch().catch((error) => {
            failureHandlerRef.current?.("dispatch", toError(error));
          });
        };

        const handleFailure = (reason: RpcFailureReason, rawError: Error) => {
          const attempt = currentAttemptRef.current || 1;
          const normalized = toError(rawError);
          const options = retryOptionsRef.current;
          if (!options) {
            finalizeError(reason, normalized, attempt);
            return;
          }

          const withinLimit = attempt < options.maxAttempts;
          const shouldRetry = withinLimit && options.shouldRetry({
            requestId,
            attempt,
            maxAttempts: options.maxAttempts,
            reason,
            error: normalized,
          });

          if (!shouldRetry) {
            finalizeError(reason, normalized, attempt);
            return;
          }

          const nextAttempt = attempt + 1;
          const delay = computeDelayMs(nextAttempt, options);
          options.onRetryAttempt?.({
            requestId,
            attempt: nextAttempt,
            maxAttempts: options.maxAttempts,
            reason,
            error: normalized,
            nextDelayMs: delay,
          });

          clearTimeoutHandle();
          setTimeout(() => {
            scheduleAttempt(nextAttempt);
          }, delay);
        };

        failureHandlerRef.current = (reason, error) => {
          handleFailure(reason, toError(error));
        };

        scheduleAttempt(1);
      });
    },
    [clearActiveRequest, clearTimeoutHandle, ws.isConnected]
  );

  const send = useCallback(
    (params: Omit<RequestOf<TRequest>, "type" | "requestId">, options?: SendOptions) => {
      const dispatchRequest = dispatchRef.current;
      return waitForResponse({
        requestId: generateMessageId(),
        dispatch: (generatedId) => {
          const request = {
            type: requestType,
            ...params,
            requestId: generatedId,
          } as RequestOf<TRequest>;
          if (dispatchRequest) {
            return dispatchRequest(request);
          }
          ws.send({ type: "session", message: request });
        },
        retry: options?.retry,
        timeoutMs: options?.timeoutMs,
      });
    },
    [requestType, waitForResponse, ws]
  );

  const reset = useCallback(() => {
    clearActiveRequest();
    setState({ status: "idle", requestId: null });
  }, [clearActiveRequest]);

  return useMemo(
    () => ({
      state,
      send,
      waitForResponse,
      reset,
    }),
    [reset, send, state, waitForResponse]
  );
}
