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

type ResponseWithRequestId<TType extends SharedType> = ResponseOf<TType> & {
  payload: { requestId?: string; error?: string };
};

type SelectResponse<TType extends SharedType, TData> = (message: ResponseWithRequestId<TType>) => TData;

export function useSessionRpc<TType extends SharedType, TData = ResponseWithRequestId<TType>["payload"]>(options: {
  ws: UseWebSocketReturn;
  type: TType;
  select?: SelectResponse<TType, TData>;
}) {
  const { ws, type, select } = options;
  const [state, setState] = useState<RpcState<TData>>({ status: "idle", requestId: null });
  const activeRequestIdRef = useRef<string | null>(null);
  const resolveRef = useRef<((value: TData) => void) | null>(null);
  const rejectRef = useRef<((reason?: any) => void) | null>(null);

  useEffect(() => {
    const unsubscribe = ws.on(type, (message) => {
      const payload = (message as ResponseWithRequestId<TType>).payload;
      if (!payload || payload.requestId !== activeRequestIdRef.current) {
        return;
      }

      if (payload.error) {
        const error = new Error(payload.error);
        setState({ status: "error", requestId: payload.requestId ?? null, error });
        rejectRef.current?.(error);
        activeRequestIdRef.current = null;
        return;
      }

      const data = select ? select(message as ResponseWithRequestId<TType>) : ((payload as unknown) as TData);
      setState({ status: "success", requestId: payload.requestId ?? null, data });
      resolveRef.current?.(data);
      activeRequestIdRef.current = null;
    });

    return () => {
      unsubscribe();
    };
  }, [select, type, ws]);

  const send = useCallback(
    (params: Omit<RequestOf<TType>, "type" | "requestId">) => {
      const requestId = generateMessageId();
      activeRequestIdRef.current = requestId;
      setState({ status: "loading", requestId });

      const request = {
        type,
        ...params,
        requestId,
      } as RequestOf<TType>;

      ws.send({ type: "session", message: request });

      return new Promise<TData>((resolve, reject) => {
        resolveRef.current = resolve;
        rejectRef.current = reject;
      });
    },
    [type, ws]
  );

  const reset = useCallback(() => {
    activeRequestIdRef.current = null;
    setState({ status: "idle", requestId: null });
  }, []);

  return useMemo(() => ({ state, send, reset }), [reset, send, state]);
}
