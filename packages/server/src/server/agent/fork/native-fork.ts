import type { AgentSession } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";

export class NativeForkCapabilityError extends Error {
  constructor() {
    super("Provider does not support forking a session");
    this.name = "NativeForkCapabilityError";
  }
}

function providerUserMessageId(row: AgentTimelineRow): string {
  if (row.item.type !== "user_message") {
    throw new Error("Native fork boundary did not resolve to a user message");
  }
  if (row.item.clientMessageId && !row.providerMessageId) {
    throw new Error("Cannot fork before the provider acknowledges the submitted prompt");
  }
  return row.providerMessageId ?? row.item.messageId ?? row.item.clientMessageId ?? "";
}

export function resolveNativeForkMessageId(
  rows: readonly AgentTimelineRow[],
  boundaryMessageId: string,
): string {
  const directUserRow = rows.findLast(
    (row) => row.item.type === "user_message" && row.item.messageId === boundaryMessageId,
  );
  if (directUserRow) {
    const messageId = providerUserMessageId(directUserRow);
    if (messageId) return messageId;
  }

  const assistantIndex = rows.findLastIndex(
    (row) => row.item.type === "assistant_message" && row.item.messageId === boundaryMessageId,
  );
  if (assistantIndex < 0) {
    return boundaryMessageId;
  }

  const assistantRow = rows[assistantIndex];
  const userRow = rows
    .slice(0, assistantIndex)
    .findLast(
      (row) =>
        row.item.type === "user_message" &&
        (!assistantRow?.turnId || !row.turnId || row.turnId === assistantRow.turnId),
    );
  if (!userRow) {
    throw new Error("Cannot find the user message for the selected assistant response");
  }
  const messageId = providerUserMessageId(userRow);
  if (!messageId) {
    throw new Error("Selected user message has no provider message id");
  }
  return messageId;
}

/**
 * Branch the provider session and hand back its new native handle. The source
 * session is left bound and running: unlike rewind, both branches stay live.
 *
 * A boundary is mandatory. Both supporting providers fork from persisted
 * session state, so a fork taken with no boundary would silently exclude an
 * in-flight turn. Callers that want "everything up to now" use the summary
 * fork path instead, which projects the live timeline.
 */
export async function invokeNativeForkCapability(
  session: AgentSession,
  input: { messageId: string },
): Promise<{ providerHandleId: string }> {
  if (!session.capabilities.supportsNativeFork || !session.forkNativeSession) {
    throw new NativeForkCapabilityError();
  }
  const forked = await session.forkNativeSession({ messageId: input.messageId });
  const providerHandleId = forked.providerHandleId.trim();
  if (!providerHandleId) {
    throw new Error("Provider returned an empty session handle for the fork");
  }
  return { providerHandleId };
}
