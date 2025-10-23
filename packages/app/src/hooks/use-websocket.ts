import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  WSInboundMessage,
  WSOutboundMessage,
  SessionOutboundMessage
} from '@server/server/messages';

export interface UseWebSocketReturn {
  isConnected: boolean;
  conversationId: string | null;
  send: (message: WSInboundMessage) => void;
  on: (type: SessionOutboundMessage['type'], handler: (message: SessionOutboundMessage) => void) => () => void;
  sendPing: () => void;
  sendUserMessage: (message: string) => void;
}

export function useWebSocket(url: string, conversationId?: string | null): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<SessionOutboundMessage['type'], Set<(message: SessionOutboundMessage) => void>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      // Add conversation ID to URL if provided
      const wsUrl = conversationId ? `${url}?conversationId=${conversationId}` : url;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[WS] Connected to server');
        setIsConnected(true);
      };

      ws.onclose = () => {
        console.log('[WS] Disconnected from server');
        setIsConnected(false);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[WS] Attempting to reconnect...');
          connect();
        }, 3000);
      };

      ws.onerror = (error) => {
        console.warn('[WS] Error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const wsMessage: WSOutboundMessage = JSON.parse(event.data);

          // Only session messages trigger handlers
          if (wsMessage.type === 'session') {
            const sessionMessage = wsMessage.message;
            console.log(`[WS] Received session message type: ${sessionMessage.type}`);

            // Track conversation ID when loaded
            if (sessionMessage.type === 'conversation_loaded') {
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
            // pong - just log
            console.log(`[WS] Received ${wsMessage.type}`);
          }
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.warn('[WS] Failed to create WebSocket:', err);
    }
  }, [url, conversationId]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const send = useCallback((message: WSInboundMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('[WS] Cannot send message - not connected');
    }
  }, []);

  const on = useCallback((
    type: SessionOutboundMessage['type'],
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
  }, []);

  const sendPing = useCallback(() => {
    send({ type: 'ping' });
  }, [send]);

  const sendUserMessage = useCallback(
    (message: string) => {
      send({
        type: 'session',
        message: {
          type: 'user_text',
          text: message,
        },
      });
    },
    [send]
  );

  return {
    isConnected,
    conversationId: currentConversationId,
    send,
    on,
    sendPing,
    sendUserMessage,
  };
}
