import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInboundMessage, SessionOutboundMessage } from "@server/server/messages";
import type { UseWebSocketReturn } from "./use-websocket";
import { generateMessageId } from "@/types/stream";

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

type WaitForResponseOptions = {
  requestId: string;
  dispatch?: (requestId: string) => void | Promise<void>;
};

type UseSessionRpcReturn<TRequest extends RequestType, TData> = {
  state: RpcState<TData>;
  send: (params: Omit<RequestOf<TRequest>, "type" | "requestId">) => Promise<TData>;
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
  const rejectRef = useRef<((reason?: any) => void) | null>(null);
  const dispatchRef = useRef<DispatchRequest<TRequest> | undefined>(dispatch);

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const clearActiveRequest = useCallback(() => {
    activeRequestIdRef.current = null;
    resolveRef.current = null;
    rejectRef.current = null;
  }, []);

  useEffect(() => {
    const unsubscribe = ws.on(responseType, (message) => {
      const typedMessage = message as ResponseWithEnvelope<TResponse>;
      const payload = typedMessage.payload;
      const expectedId = activeRequestIdRef.current;
      if (!payload || !expectedId || payload.requestId !== expectedId) {
        return;
      }

      const payloadError =
        payload && typeof payload === "object" && "error" in payload && typeof (payload as any).error === "string"
          ? ((payload as any).error as string)
          : null;
      if (payloadError) {
        const error = new Error(payloadError);
        setState({ status: "error", requestId: payload.requestId ?? null, error });
        rejectRef.current?.(error);
        clearActiveRequest();
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
  }, [clearActiveRequest, responseType, select, ws]);

  useEffect(() => {
    if (ws.isConnected || !activeRequestIdRef.current) {
      return;
    }
    const error = new Error("WebSocket disconnected");
    setState({ status: "error", requestId: activeRequestIdRef.current, error });
    rejectRef.current?.(error);
    clearActiveRequest();
  }, [clearActiveRequest, ws.isConnected]);

  const waitForResponse = useCallback(
    ({ requestId, dispatch: dispatchOverride }: WaitForResponseOptions) => {
      return new Promise<TData>((resolve, reject) => {
        if (!ws.isConnected) {
          const error = new Error("WebSocket is disconnected");
          setState({ status: "error", requestId: null, error });
          reject(error);
          return;
        }

        activeRequestIdRef.current = requestId;
        resolveRef.current = resolve;
        rejectRef.current = reject;
        setState({ status: "loading", requestId });

        if (!dispatchOverride) {
          return;
        }

        const handleDispatchError = (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          setState({ status: "error", requestId, error: err });
          reject(err);
          clearActiveRequest();
        };

        try {
          const maybePromise = dispatchOverride(requestId);
          if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
            (maybePromise as Promise<unknown>).catch(handleDispatchError);
          }
        } catch (error) {
          handleDispatchError(error);
        }
      });
    },
    [clearActiveRequest, ws.isConnected]
  );

  const send = useCallback(
    (params: Omit<RequestOf<TRequest>, "type" | "requestId">) => {
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
