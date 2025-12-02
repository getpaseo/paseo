import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { AppState } from "react-native";
import type {
  WSInboundMessage,
  WSOutboundMessage,
  SessionOutboundMessage,
} from "@server/server/messages";

export interface ConnectionStatusSnapshot {
  isConnected: boolean;
  isConnecting: boolean;
}

export interface UseWebSocketReturn {
  isConnected: boolean;
  isConnecting: boolean;
  conversationId: string | null;
  lastError: string | null;
  send: (message: WSInboundMessage) => void;
  on: (
    type: SessionOutboundMessage["type"],
    handler: (message: SessionOutboundMessage) => void
  ) => () => void;
  sendPing: () => void;
  sendUserMessage: (message: string) => void;
  subscribeConnectionStatus?: (listener: (status: ConnectionStatusSnapshot) => void) => () => void;
  getConnectionState?: () => ConnectionStatusSnapshot;
}

const RECONNECT_BASE_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30000;

export function useWebSocket(url: string, conversationId?: string | null): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef =
    useRef<Map<SessionOutboundMessage["type"], Set<(message: SessionOutboundMessage) => void>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const connectionListenersRef = useRef(new Set<(status: ConnectionStatusSnapshot) => void>());
  const connectionStateRef = useRef<ConnectionStatusSnapshot>({ isConnected: false, isConnecting: true });

  const notifyConnectionListeners = useCallback((state: ConnectionStatusSnapshot) => {
    connectionStateRef.current = state;
    for (const listener of connectionListenersRef.current) {
      try {
        listener(state);
      } catch (error) {
        console.error("[WS] Connection listener error", error);
      }
    }
  }, []);

  const updateConnectionState = useCallback((state: ConnectionStatusSnapshot) => {
    setIsConnected(state.isConnected);
    setIsConnecting(state.isConnecting);
    notifyConnectionListeners(state);
  }, [notifyConnectionListeners]);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let scheduledReconnect = false;
    const scheduleReconnect = (reason?: string) => {
      if (scheduledReconnect || !shouldReconnectRef.current) {
        return;
      }
      scheduledReconnect = true;

      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // no-op
        }
        wsRef.current = null;
      }

      if (typeof reason === "string" && reason.trim().length > 0) {
        setLastError(reason.trim());
      }

      updateConnectionState({ isConnected: false, isConnecting: false });

      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      reconnectAttemptRef.current = attempt + 1;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = undefined;
        if (!shouldReconnectRef.current) {
          return;
        }
      updateConnectionState({ isConnected: false, isConnecting: true });
      connect();
    }, delay);
  };

    try {
      // Add conversation ID to URL if provided
      const wsUrl = conversationId ? `${url}?conversationId=${conversationId}` : url;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      updateConnectionState({ isConnected: false, isConnecting: true });

      ws.onopen = () => {
        console.log("[WS] Connected to server");
        updateConnectionState({ isConnected: true, isConnecting: false });
        setLastError(null);
        reconnectAttemptRef.current = 0;
      };

      ws.onclose = (event) => {
        console.log("[WS] Disconnected from server");
        const reason =
          typeof event?.reason === "string" && event.reason.trim().length > 0
            ? event.reason.trim()
            : `Socket closed (code ${event?.code ?? "unknown"})`;
        updateConnectionState({ isConnected: false, isConnecting: false });
        scheduleReconnect(reason);
      };

      ws.onerror = (errorEvent) => {
        let reason = "WebSocket error";
        if (
          errorEvent &&
          typeof errorEvent === "object" &&
          "message" in errorEvent &&
          typeof (errorEvent as { message: unknown }).message === "string"
        ) {
          const message = ((errorEvent as { message: string }).message || "").trim();
          reason = message.length > 0 ? message : reason;
        }
        console.warn("[WS] Error:", errorEvent);
        scheduleReconnect(reason);
      };

      ws.onmessage = (event) => {
        try {
          const rawData = event.data;
          const size = typeof rawData === "string" ? rawData.length : 0;
          const wsMessage: WSOutboundMessage = JSON.parse(rawData);

          // Only session messages trigger handlers
          if (wsMessage.type === "session") {
            const sessionMessage = wsMessage.message;
            const id = (sessionMessage as { requestId?: string }).requestId ??
                       (sessionMessage as { agentId?: string }).agentId ??
                       (sessionMessage as { payload?: { agentId?: string } }).payload?.agentId;
            console.log(`[WS] ← ${sessionMessage.type}`, { size, id: id ?? "-" });

            // Track conversation ID when loaded
            if (sessionMessage.type === "conversation_loaded") {
              setCurrentConversationId(sessionMessage.payload.conversationId);
            }

            // Call all registered handlers for this message type
            const handlers = handlersRef.current.get(sessionMessage.type);
            if (handlers) {
              handlers.forEach((handler) => {
                try {
                  handler(sessionMessage);
                } catch (err) {
                  console.error(`[WS] Error in handler for ${sessionMessage.type}:`, err);
                }
              });
            }
          } else {
            // pong
            console.log(`[WS] ← ${wsMessage.type}`, { size });
          }
        } catch (err) {
          console.error("[WS] Failed to parse message:", err);
        }
      };
    } catch (err) {
      console.warn("[WS] Failed to create WebSocket:", err);
      const reason = err instanceof Error ? err.message : "Failed to create WebSocket";
      scheduleReconnect(reason);
    }
  }, [updateConnectionState, url, conversationId]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    setIsConnecting(true);
    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }

      const readyState = wsRef.current?.readyState;
      if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
        return;
      }

      shouldReconnectRef.current = true;
      setIsConnecting(true);
      connect();
    });

    return () => {
      subscription.remove();
    };
  }, [connect]);

  const send = useCallback((message: WSInboundMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(message);
      const type = message.type === "session" ? message.message.type : message.type;
      const id = message.type === "session"
        ? (message.message as { requestId?: string; agentId?: string }).requestId ??
          (message.message as { agentId?: string }).agentId
        : undefined;
      console.log(`[WS] → ${type}`, { size: payload.length, id: id ?? "-" });
      wsRef.current.send(payload);
    } else {
      console.warn("[WS] Cannot send message - not connected");
    }
  }, []);

  const on = useCallback(
    (
      type: SessionOutboundMessage["type"],
      handler: (message: SessionOutboundMessage) => void
    ) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);

      // Return cleanup function
      return () => {
        const handlers = handlersRef.current.get(type);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            handlersRef.current.delete(type);
          }
        }
      };
    },
    []
  );

  const sendPing = useCallback(() => {
    send({ type: "ping" });
  }, [send]);

  const sendUserMessage = useCallback(
    (message: string) => {
      send({
        type: "session",
        message: {
          type: "user_text",
          text: message,
        },
      });
    },
    [send]
  );

  const subscribeConnectionStatus = useCallback(
    (listener: (status: ConnectionStatusSnapshot) => void) => {
      connectionListenersRef.current.add(listener);
      listener(connectionStateRef.current);
      return () => {
        connectionListenersRef.current.delete(listener);
      };
    },
    []
  );

  const getConnectionState = useCallback(() => {
    const readyState = wsRef.current?.readyState ?? WebSocket.CLOSED;
    return {
      isConnected: readyState === WebSocket.OPEN,
      isConnecting: readyState === WebSocket.CONNECTING,
    } satisfies ConnectionStatusSnapshot;
  }, []);

  return useMemo(
    () => ({
      isConnected,
      isConnecting,
      conversationId: currentConversationId,
      lastError,
      send,
      on,
      sendPing,
      sendUserMessage,
      subscribeConnectionStatus,
      getConnectionState,
    }),
    [
      isConnected,
      isConnecting,
      currentConversationId,
      lastError,
      send,
      on,
      sendPing,
      sendUserMessage,
      subscribeConnectionStatus,
      getConnectionState,
    ]
  );
}
