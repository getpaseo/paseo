import { base64EncryptedWireByteLength } from "@getpaseo/relay";
import {
  wrapSessionMessage,
  type FetchAgentTimelineResponseMessage,
} from "@getpaseo/protocol/messages";
import { MAX_RELAY_PAYLOAD_BYTES } from "./websocket/relay-payload.js";

export function boundTimelineResponse(
  message: FetchAgentTimelineResponseMessage,
  selectPage: (limit: number) => FetchAgentTimelineResponseMessage,
): FetchAgentTimelineResponseMessage {
  let limit = message.payload.entries.length;
  while (
    base64EncryptedWireByteLength(Buffer.byteLength(JSON.stringify(wrapSessionMessage(message)))) >
    MAX_RELAY_PAYLOAD_BYTES
  ) {
    if (limit <= 1) {
      throw new Error("A timeline item or its metadata exceeds the relay payload limit");
    }
    limit = Math.ceil(limit / 2);
    message = selectPage(limit);
  }
  return message;
}
