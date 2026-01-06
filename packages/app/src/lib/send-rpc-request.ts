import type {
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@server/server/messages";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import { generateMessageId } from "@/types/stream";

// ============================================================================
// Type-level utilities for automatic request→response type inference
// ============================================================================

/**
 * Extract the payload type from a message.
 */
type PayloadOf<TMessage> = TMessage extends { payload: infer P } ? P : never;

/**
 * All request message types that can be used with sendRpcRequest.
 * These are inbound messages that end with `_request`.
 */
type RpcRequestMessage = Extract<SessionInboundMessage, { type: `${string}_request` }>;

/**
 * Extract the type literal from a request message.
 */
type RpcRequestType = RpcRequestMessage["type"];

/**
 * Override mapping for requests that don't follow the standard `_request` → `_response` pattern.
 */
interface ResponseTypeOverrides {
  create_agent_request: "agent_state";
  refresh_agent_request: "agent_state";
  initialize_agent_request: "initialize_agent_request";
}

/**
 * Convert request type string to response type string.
 * - First checks override mapping for non-standard patterns
 * - Falls back to standard `*_request` → `*_response` conversion
 */
type RequestToResponseType<T extends string> = T extends keyof ResponseTypeOverrides
  ? ResponseTypeOverrides[T]
  : T extends `${infer Base}_request`
    ? `${Base}_response`
    : never;

/**
 * Given a request type string, get the response message type.
 */
type ResponseMessageFor<T extends RpcRequestType> = Extract<
  SessionOutboundMessage,
  { type: RequestToResponseType<T> }
>;

/**
 * Given a request type string, get the payload type of the response.
 */
type ResponsePayloadFor<T extends RpcRequestType> = PayloadOf<ResponseMessageFor<T>>;

/**
 * Given a request type string, get the request message type (without requestId).
 */
type RequestInputFor<T extends RpcRequestType> = Omit<
  Extract<SessionInboundMessage, { type: T }>,
  "requestId"
>;

/**
 * Infer the request type from a request object.
 * This enables TypeScript to narrow based on the `type` property.
 */
type InferRequestType<TRequest> = TRequest extends { type: infer T extends RpcRequestType }
  ? T
  : never;

// ============================================================================
// Runtime configuration
// ============================================================================

interface SendRpcRequestOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "response_error" | "disconnected"
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Maps request types to their corresponding response types at runtime.
 */
const RESPONSE_TYPE_MAP: Record<string, SessionOutboundMessage["type"]> = {
  git_diff_request: "git_diff_response",
  highlighted_diff_request: "highlighted_diff_response",
  file_explorer_request: "file_explorer_response",
  file_download_token_request: "file_download_token_response",
  git_repo_info_request: "git_repo_info_response",
  list_provider_models_request: "list_provider_models_response",
  list_conversations_request: "list_conversations_response",
  list_persisted_agents_request: "list_persisted_agents_response",
  create_agent_request: "agent_state",
  refresh_agent_request: "agent_state",
  initialize_agent_request: "initialize_agent_request",
};

// ============================================================================
// Main function
// ============================================================================

/**
 * Send an RPC request over WebSocket and wait for the matching response.
 *
 * Features:
 * - Auto-generates and injects requestId into the request
 * - Matches response by requestId in payload
 * - Fully typed: response type is inferred from request type
 * - Throws on timeout or if response contains an error field
 *
 * @example
 * ```ts
 * const response = await sendRpcRequest(ws, {
 *   type: "git_diff_request",
 *   agentId: "abc123",
 * });
 * // response is typed as { agentId: string; diff: string; error: string | null }
 * ```
 */
export function sendRpcRequest<
  const TRequest extends RequestInputFor<RpcRequestType>
>(
  ws: UseWebSocketReturn,
  request: TRequest,
  options?: SendRpcRequestOptions
): Promise<ResponsePayloadFor<InferRequestType<TRequest>>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = generateMessageId();
  const requestType = (request as { type: string }).type;
  const responseType = RESPONSE_TYPE_MAP[requestType];

  if (!responseType) {
    return Promise.reject(
      new RpcError(`Unknown request type: ${requestType}`, "response_error")
    );
  }

  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const settle = <U>(fn: () => U): U | undefined => {
      if (settled) {
        return undefined;
      }
      settled = true;
      cleanup();
      return fn();
    };

    // Subscribe to the response type
    unsubscribe = ws.on(responseType, (message) => {
      const payload = (message as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") {
        return;
      }

      const payloadRecord = payload as Record<string, unknown>;

      // Match by requestId
      if (payloadRecord.requestId !== requestId) {
        return;
      }

      // Check for error in response
      if (
        typeof payloadRecord.error === "string" &&
        payloadRecord.error.length > 0
      ) {
        settle(() =>
          reject(new RpcError(payloadRecord.error as string, "response_error"))
        );
        return;
      }

      settle(() => resolve(payload as ResponsePayloadFor<InferRequestType<TRequest>>));
    });

    // Set up timeout
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        settle(() =>
          reject(
            new RpcError(`RPC request timed out after ${timeoutMs}ms`, "timeout")
          )
        );
      }, timeoutMs);
    }

    // Send the request with the generated requestId
    const fullRequest = {
      ...request,
      requestId,
    } as SessionInboundMessage;

    ws.send({
      type: "session",
      message: fullRequest,
    });
  });
}

export { RpcError };
export type { RpcRequestType, ResponsePayloadFor, RequestInputFor };
