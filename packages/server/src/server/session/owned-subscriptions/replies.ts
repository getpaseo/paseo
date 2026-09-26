import type {
  KnownStatusPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";

type Request = Extract<SessionInboundMessage, { requestId?: string }>;
type ConventionalReply<T extends string> = T extends `${infer P}.request`
  ? `${P}.response`
  : T extends `${infer P}_request`
    ? `${P}_response`
    : T extends `${string}/${string}`
      ? `${T}/response`
      : `${T}_response`;
type CorrelatedType<M> = M extends { type: infer T; payload: infer P }
  ? "requestId" extends keyof P
    ? T
    : never
  : never;
type StatusReply = Extract<KnownStatusPayload, { requestId: string }>["status"];
type ExceptionalReply = Exclude<
  CorrelatedType<Exclude<SessionOutboundMessage, { type: "status" }>>,
  ConventionalReply<Request["type"]> | "rpc_error"
>;

// Naming is a protocol convention, not proof. Every nonconforming correlated output
// must declare its originating request; additions to the wire union fail typecheck here.
const exceptions = {
  pong: ["ping"],
  agent_archived: ["archive_agent_request"],
  agent_deleted: ["delete_agent_request"],
  agent_permission_resolved: ["agent_permission_response"],
  terminals_changed: ["subscribe_terminals_request"],
  "daemon.update.progress": ["daemon.update.request"],
  // Transcription belongs to the explicitly retained voice operation, not a request ID.
  transcription_result: [],
  // This legacy requestId is a producer marker; checkout updates require event demand.
  checkout_status_update: [],
} satisfies Record<ExceptionalReply, readonly Request["type"][]>;
const statuses = {
  agent_created: ["create_agent_request"],
  agent_create_failed: ["create_agent_request", "import_agent_request"],
  agent_resumed: ["resume_agent_request", "import_agent_request"],
  agent_refreshed: ["refresh_agent_request"],
  restart_requested: ["restart_server_request"],
  shutdown_requested: ["shutdown_server_request"],
} satisfies Record<StatusReply, readonly Request["type"][]>;

export function isReply(request: SessionInboundMessage, message: SessionOutboundMessage): boolean {
  if (
    !("requestId" in request) ||
    !("payload" in message) ||
    !("requestId" in message.payload) ||
    message.payload.requestId !== request.requestId
  )
    return false;
  if (message.type === "rpc_error") return message.payload.requestType === request.type;
  const declared: Readonly<Record<string, readonly string[]>> =
    message.type === "status" ? statuses : exceptions;
  const key = message.type === "status" ? message.payload.status : message.type;
  if (key in declared) return declared[key].includes(request.type);
  if (message.type === "status") return false;
  if (request.type.endsWith(".request"))
    return message.type === request.type.replace(/\.request$/, ".response");
  if (request.type.endsWith("_request"))
    return message.type === request.type.replace(/_request$/, "_response");
  if (request.type.includes("/")) return message.type === `${request.type}/response`;
  return message.type === `${request.type}_response`;
}
