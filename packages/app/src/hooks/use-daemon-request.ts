import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionOutboundMessage, WSInboundMessage } from "@server/server/messages";
import type { UseWebSocketReturn } from "./use-websocket";
import { generateMessageId } from "@/types/stream";

type RequestStatus = "idle" | "loading" | "success" | "error";

type MaybeUndefined<T> = T | undefined;
type ExecuteParams<TParams> = TParams extends void ? void | undefined : TParams;

export interface RequestContext<TParams> {
  params: MaybeUndefined<TParams>;
  requestId: string;
  key: string;
  attempt: number;
}

type RetryDelay =
  | number
  | ((attempt: number) => number);

export interface UseDaemonRequestOptions<
  TParams = void,
  TData = unknown,
  TMessage extends SessionOutboundMessage = SessionOutboundMessage
> {
  ws: UseWebSocketReturn;
  /**
   * Session message type to subscribe to for responses.
   */
  responseType: TMessage["type"];
  /**
   * Builder that receives params + the generated requestId and returns the outbound WS message.
   */
  buildRequest: (context: { params: MaybeUndefined<TParams>; requestId: string }) => WSInboundMessage;
  /**
   * Extracts the typed data from the inbound response.
   */
  selectData: (message: TMessage, context: RequestContext<TParams>) => TData;
  /**
   * Override response matching behavior. Defaults to comparing payload.requestId when available.
   */
  matchResponse?: (message: TMessage, context: RequestContext<TParams>) => boolean;
  /**
   * Returns the request key for dedupe. Defaults to JSON.stringify(params) or "default".
   */
  getRequestKey?: (params: MaybeUndefined<TParams>) => string;
  /**
   * Returns an error (string or Error) when the payload represents a failure.
   */
  extractError?: (message: TMessage, context: RequestContext<TParams>) => string | Error | null;
  /**
   * Milliseconds before a request automatically times out. Pass null to disable.
   */
  timeoutMs?: number | null;
  /**
   * Number of retry attempts after the initial send.
   */
  retryCount?: number;
  /**
   * Delay between retries (ms) or function that maps attempt -> delay.
   */
  retryDelayMs?: RetryDelay;
  /**
   * Keep previously resolved data while loading.
   */
  keepPreviousData?: boolean;
  /**
   * Provide initial data before running the request.
   */
  initialData?: TData | null;
  /**
   * Disable deduplication (send every execute call even if one is in-flight).
   */
  dedupe?: boolean;
}

export interface ExecuteRequestOptions {
  timeoutMs?: number | null;
  retryCount?: number;
  retryDelayMs?: RetryDelay;
  dedupe?: boolean;
  requestKeyOverride?: string;
}

export interface UseDaemonRequestResult<TParams, TData> {
  status: RequestStatus;
  data: TData | null;
  error: Error | null;
  isIdle: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  requestId: string | null;
  updatedAt: number | null;
  execute: (params?: ExecuteParams<TParams>, options?: ExecuteRequestOptions) => Promise<TData>;
  reset: () => void;
  cancel: (reason?: string) => void;
}

interface ActiveRequest<TParams, TData, TMessage extends SessionOutboundMessage> {
  key: string;
  params: MaybeUndefined<TParams>;
  requestId: string;
  attempt: number;
  promise: Promise<TData>;
  resolve: (data: TData) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  retryHandle: ReturnType<typeof setTimeout> | null;
  aborted: boolean;
  options: ResolvedBehavior;
}

interface ResolvedBehavior {
  timeoutMs: number | null;
  retryCount: number;
  retryDelayMs: RetryDelay;
  dedupe: boolean;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_DELAY_MS = 750;

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function resolveKey(params: unknown): string {
  if (params === undefined || params === null) {
    return "default";
  }

  if (typeof params === "string" || typeof params === "number" || typeof params === "boolean") {
    return String(params);
  }

  try {
    return JSON.stringify(params);
  } catch {
    return "default";
  }
}

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown request error");
}

export function useDaemonRequest<
  TParams = void,
  TData = unknown,
  TMessage extends SessionOutboundMessage = SessionOutboundMessage
>(options: UseDaemonRequestOptions<TParams, TData, TMessage>): UseDaemonRequestResult<TParams, TData> {
  const {
    ws,
    responseType,
    buildRequest,
    selectData,
    matchResponse,
    getRequestKey,
    extractError,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryCount = 0,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    keepPreviousData = true,
    initialData = null,
    dedupe = true,
  } = options;

  const buildRequestRef = useLatest(buildRequest);
  const selectDataRef = useLatest(selectData);
  const matchResponseRef = useLatest(matchResponse);
  const extractErrorRef = useLatest(extractError);
  const getRequestKeyRef = useLatest(getRequestKey);

  const [state, setState] = useState<{
    status: RequestStatus;
    data: TData | null;
    error: Error | null;
    requestId: string | null;
    updatedAt: number | null;
  }>(() => ({
    status: initialData === null ? "idle" : "success",
    data: initialData,
    error: null,
    requestId: null,
    updatedAt: initialData === null ? null : Date.now(),
  }));

  const activeRequestRef = useRef<ActiveRequest<TParams, TData, TMessage> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      const active = activeRequestRef.current;
      if (active) {
        if (active.timeoutHandle) {
          clearTimeout(active.timeoutHandle);
        }
        if (active.retryHandle) {
          clearTimeout(active.retryHandle);
        }
        activeRequestRef.current = null;
      }
    };
  }, []);

  const cleanupActiveRequest = useCallback(() => {
    const current = activeRequestRef.current;
    if (!current) {
      return;
    }
    if (current.timeoutHandle) {
      clearTimeout(current.timeoutHandle);
    }
    if (current.retryHandle) {
      clearTimeout(current.retryHandle);
    }
    activeRequestRef.current = null;
  }, []);

  const applyState = useCallback(
    (updater: (prev: typeof state) => typeof state) => {
      if (!isMountedRef.current) {
        return;
      }
      setState(updater);
    },
    []
  );

  const getMatchFn = useCallback(
    (context: RequestContext<TParams>) => {
      const userMatch = matchResponseRef.current;
      if (userMatch) {
        return (message: TMessage) => userMatch(message, context);
      }
      return (message: TMessage) => {
        const payload = (message as { payload?: { requestId?: unknown } }).payload;
        if (
          payload &&
          typeof payload === "object" &&
          "requestId" in payload &&
          typeof (payload as { requestId?: unknown }).requestId === "string"
        ) {
          return (payload as { requestId?: string }).requestId === context.requestId;
        }
        return true;
      };
    },
    [matchResponseRef]
  );

  const resolvedBehavior = useCallback(
    (overrides?: ExecuteRequestOptions): ResolvedBehavior => ({
      timeoutMs:
        overrides?.timeoutMs !== undefined
          ? overrides.timeoutMs
          : timeoutMs ?? null,
      retryCount: overrides?.retryCount ?? retryCount,
      retryDelayMs: overrides?.retryDelayMs ?? retryDelayMs,
      dedupe: overrides?.dedupe ?? dedupe,
    }),
    [timeoutMs, retryCount, retryDelayMs, dedupe]
  );

  const sendAttempt = useCallback(
    (request: ActiveRequest<TParams, TData, TMessage>) => {
      if (request.aborted) {
        return;
      }

      request.attempt += 1;

      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }

      try {
        const message = buildRequestRef.current({
          params: request.params,
          requestId: request.requestId,
        });
        ws.send(message);
      } catch (error) {
        const err = ensureError(error);
        request.reject(err);
        cleanupActiveRequest();
        applyState((prev) => ({
          status: "error",
          data: keepPreviousData ? prev.data : null,
          error: err,
          requestId: null,
          updatedAt: Date.now(),
        }));
        return;
      }

      const timeoutDuration =
        typeof request.options.timeoutMs === "number"
          ? request.options.timeoutMs
          : null;

      if (timeoutDuration && timeoutDuration > 0) {
        request.timeoutHandle = setTimeout(() => {
          if (request.aborted) {
            return;
          }
          const timeoutError = new Error(
            `Request timed out after ${timeoutDuration}ms`
          );
          const maxAttempts = request.options.retryCount + 1;
          if (request.attempt >= maxAttempts) {
            cleanupActiveRequest();
            request.reject(timeoutError);
            applyState((prev) => ({
              status: "error",
              data: keepPreviousData ? prev.data : null,
              error: timeoutError,
              requestId: null,
              updatedAt: Date.now(),
            }));
            return;
          }
          const delay =
            typeof request.options.retryDelayMs === "function"
              ? request.options.retryDelayMs(request.attempt)
              : request.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
          request.retryHandle = setTimeout(() => {
            sendAttempt(request);
          }, Math.max(0, delay));
        }, timeoutDuration);
      }
    },
    [applyState, buildRequestRef, cleanupActiveRequest, keepPreviousData, ws]
  );

  const startRequest = useCallback(
    (params?: ExecuteParams<TParams>, overrides?: ExecuteRequestOptions) => {
      const normalizedParams = params as MaybeUndefined<TParams>;
      const behavior = resolvedBehavior(overrides);
      const computedKey =
        overrides?.requestKeyOverride ??
        getRequestKeyRef.current?.(normalizedParams) ??
        resolveKey(normalizedParams);
      const active = activeRequestRef.current;
      if (behavior.dedupe && active && active.key === computedKey) {
        return active.promise;
      }

      let resolveFn!: (value: TData) => void;
      let rejectFn!: (error: Error) => void;
      const promise = new Promise<TData>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      const request: ActiveRequest<TParams, TData, TMessage> = {
        key: computedKey,
        params: normalizedParams,
        requestId: generateMessageId(),
        attempt: 0,
        promise,
        resolve: resolveFn,
        reject: rejectFn,
        timeoutHandle: null,
        retryHandle: null,
        aborted: false,
        options: behavior,
      };

      activeRequestRef.current = request;

      applyState((prev) => ({
        status: "loading",
        data: keepPreviousData ? prev.data : null,
        error: null,
        requestId: request.requestId,
        updatedAt: prev.updatedAt,
      }));

      sendAttempt(request);
      return promise;
    },
    [applyState, getRequestKeyRef, keepPreviousData, resolvedBehavior, sendAttempt]
  );

  useEffect(() => {
    const unsubscribe = ws.on(responseType, (message) => {
      const active = activeRequestRef.current;
      if (!active) {
        return;
      }
      const castedMessage = message as TMessage;
      const context: RequestContext<TParams> = {
        params: active.params,
        requestId: active.requestId,
        key: active.key,
        attempt: active.attempt,
      };
      const matcher = getMatchFn(context);
      if (!matcher(castedMessage)) {
        return;
      }

      if (active.timeoutHandle) {
        clearTimeout(active.timeoutHandle);
        active.timeoutHandle = null;
      }
      if (active.retryHandle) {
        clearTimeout(active.retryHandle);
        active.retryHandle = null;
      }

      const maybeError = extractErrorRef.current
        ? extractErrorRef.current(castedMessage, context)
        : null;

      if (maybeError) {
        const error = ensureError(maybeError);
        const maxAttempts = active.options.retryCount + 1;
        if (active.attempt >= maxAttempts) {
          cleanupActiveRequest();
          active.reject(error);
          applyState((prev) => ({
            status: "error",
            data: keepPreviousData ? prev.data : null,
            error,
            requestId: null,
            updatedAt: Date.now(),
          }));
          return;
        }

        const delay =
          typeof active.options.retryDelayMs === "function"
            ? active.options.retryDelayMs(active.attempt)
            : active.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        active.retryHandle = setTimeout(() => {
          sendAttempt(active);
        }, Math.max(0, delay));
        return;
      }

      let data: TData;
      try {
        data = selectDataRef.current(castedMessage, context);
      } catch (error) {
        const err = ensureError(error);
        cleanupActiveRequest();
        active.reject(err);
        applyState((prev) => ({
          status: "error",
          data: keepPreviousData ? prev.data : null,
          error: err,
          requestId: null,
          updatedAt: Date.now(),
        }));
        return;
      }

      cleanupActiveRequest();
      active.resolve(data);
      applyState(() => ({
        status: "success",
        data,
        error: null,
        requestId: context.requestId,
        updatedAt: Date.now(),
      }));
    });

    return unsubscribe;
  }, [
    applyState,
    cleanupActiveRequest,
    extractErrorRef,
    getMatchFn,
    keepPreviousData,
    responseType,
    selectDataRef,
    sendAttempt,
    ws,
  ]);

  const execute = useCallback(
    (params?: ExecuteParams<TParams>, overrides?: ExecuteRequestOptions) => startRequest(params, overrides),
    [startRequest]
  );

  const reset = useCallback(() => {
    cleanupActiveRequest();
    applyState(() => ({
      status: "idle",
      data: initialData,
      error: null,
      requestId: null,
      updatedAt: null,
    }));
  }, [applyState, cleanupActiveRequest, initialData]);

  const cancel = useCallback(
    (reason?: string) => {
      const active = activeRequestRef.current;
      if (!active) {
        return;
      }
      active.aborted = true;
      cleanupActiveRequest();
      const error = new Error(reason ?? "Request cancelled");
      active.reject(error);
      applyState((prev) => ({
        status: "idle",
        data: keepPreviousData ? prev.data : null,
        error: null,
        requestId: null,
        updatedAt: prev.updatedAt,
      }));
    },
    [applyState, cleanupActiveRequest, keepPreviousData]
  );

  return useMemo(
    () => ({
      status: state.status,
      data: state.data,
      error: state.error,
      isIdle: state.status === "idle",
      isLoading: state.status === "loading",
      isSuccess: state.status === "success",
      isError: state.status === "error",
      requestId: state.requestId,
      updatedAt: state.updatedAt,
      execute,
      reset,
      cancel,
    }),
    [execute, reset, cancel, state]
  );
}
