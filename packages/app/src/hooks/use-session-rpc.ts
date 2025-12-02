import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInboundMessage, SessionOutboundMessage } from "@server/server/messages";
import type { UseWebSocketReturn } from "./use-websocket";
import { generateMessageId } from "@/types/stream";

type SharedType = SessionInboundMessage["type"] & SessionOutboundMessage["type"];

type RequestOf<TType extends SharedType> = Extract<SessionInboundMessage, { type: TType }>;
type ResponseOf<TType extends SharedType> = Extract<SessionOutboundMessage, { type: TType }>;

type RpcState<T> =
  | { status: "idle"; requestId: null }
  | { status: "loading"; requestId: string }
  | { status: "success"; requestId: string; data: T }
  | { status: "error"; requestId: string | null; error: Error };

type ResponseWithEnvelope<TType extends SharedType> = ResponseOf<TType> extends {
  payload: { requestId?: string; error?: string };
}
  ? ResponseOf<TType>
  : never;

type EnsureEnvelope<TType extends SharedType> = ResponseWithEnvelope<TType> extends never ? never : TType;

type ResponsePayload<TType extends SharedType> = ResponseWithEnvelope<TType> extends { payload: infer P }
  ? P
  : never;

type SelectResponse<TType extends SharedType, TData> = (message: ResponseWithEnvelope<TType>) => TData;

export function useSessionRpc<TType extends SharedType, TData = ResponsePayload<TType>>(options: {
  ws: UseWebSocketReturn;
  type: EnsureEnvelope<TType>;
  select?: SelectResponse<TType, TData>;
}) {
  const { ws, type, select } = options;
  const [state, setState] = useState<RpcState<TData>>({ status: "idle", requestId: null });
  const activeRequestIdRef = useRef<string | null>(null);
  const resolveRef = useRef<((value: TData) => void) | null>(null);
  const rejectRef = useRef<((reason?: any) => void) | null>(null);

  const clearActiveRequest = useCallback(() => {
    activeRequestIdRef.current = null;
    resolveRef.current = null;
    rejectRef.current = null;
  }, []);

  useEffect(() => {
    const unsubscribe = ws.on(type, (message) => {
      const typedMessage = message as ResponseWithEnvelope<TType>;
      const payload = typedMessage.payload;
      if (!payload || payload.requestId !== activeRequestIdRef.current) {
        return;
      }

      if (payload.error) {
        const error = new Error(payload.error);
        setState({ status: "error", requestId: payload.requestId ?? null, error });
        rejectRef.current?.(error);
        clearActiveRequest();
        return;
      }

      const baseData = typedMessage.payload as ResponsePayload<TType>;
      const data = select ? select(typedMessage) : (baseData as unknown as TData);
      setState({ status: "success", requestId: payload.requestId ?? null, data });
      resolveRef.current?.(data);
      clearActiveRequest();
    });

    return () => {
      unsubscribe();
    };
  }, [clearActiveRequest, select, type, ws]);

  useEffect(() => {
    if (ws.isConnected || !activeRequestIdRef.current) {
      return;
    }
    const error = new Error("WebSocket disconnected");
    setState({ status: "error", requestId: activeRequestIdRef.current, error });
    rejectRef.current?.(error);
    clearActiveRequest();
  }, [clearActiveRequest, ws.isConnected]);

  const send = useCallback(
    (params: Omit<RequestOf<TType>, "type" | "requestId">) => {
      return new Promise<TData>((resolve, reject) => {
        if (!ws.isConnected) {
          const error = new Error("WebSocket is disconnected");
          setState({ status: "error", requestId: null, error });
          reject(error);
          return;
        }

        const requestId = generateMessageId();
        activeRequestIdRef.current = requestId;
        resolveRef.current = resolve;
        rejectRef.current = reject;
        setState({ status: "loading", requestId });

        const request = {
          type,
          ...params,
          requestId,
        } as RequestOf<TType>;

        try {
          ws.send({ type: "session", message: request });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          setState({ status: "error", requestId: requestId, error: err });
          reject(err);
          clearActiveRequest();
        }
      });
    },
    [clearActiveRequest, type, ws]
  );

  const reset = useCallback(() => {
    clearActiveRequest();
    setState({ status: "idle", requestId: null });
  }, [clearActiveRequest]);

  return useMemo(() => ({ state, send, reset }), [reset, send, state]);
}
