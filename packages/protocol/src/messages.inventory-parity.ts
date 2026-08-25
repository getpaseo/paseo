import type {
  InventorySessionEntry,
  InventorySessionsRequestMessage,
  InventorySessionsResponseMessage,
  InventorySessionsResponsePayload,
  ServerInfoStatusFeatures,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "./messages.js";

type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;
type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time parity between the runtime WebSocket schemas and the generated
 * TypeScript types. Each element must resolve to `true`; any mismatch or loss
 * of a branch under `z.infer` turns into a type error.
 */
export type InventoryTypeParity = [
  // 1. SessionInboundMessage accepts "inventory.sessions.request" and is not any.
  Expect<NotAny<SessionInboundMessage>>,
  Expect<
    IsEqual<
      Extract<SessionInboundMessage, { type: "inventory.sessions.request" }>,
      InventorySessionsRequestMessage
    >
  >,

  // 2. SessionOutboundMessage accepts "inventory.sessions.response" and is not any.
  Expect<NotAny<SessionOutboundMessage>>,
  Expect<
    IsEqual<
      Extract<SessionOutboundMessage, { type: "inventory.sessions.response" }>,
      InventorySessionsResponseMessage
    >
  >,

  // 3. Inventory response payload exposes the expected fields and entry shape.
  Expect<NotAny<InventorySessionsResponsePayload>>,
  Expect<IsEqual<InventorySessionsResponsePayload["snapshot_id"], string>>,
  Expect<IsEqual<InventorySessionsResponsePayload["next_cursor"], string | null>>,
  Expect<IsEqual<InventorySessionsResponsePayload["has_more"], boolean>>,
  Expect<NotAny<InventorySessionsResponsePayload["entries"]>>,
  Expect<NotAny<InventorySessionEntry>>,
  Expect<IsEqual<InventorySessionEntry["backend"], "paseo">>,
  Expect<IsEqual<InventorySessionEntry["native_id"], string>>,
  Expect<IsEqual<InventorySessionEntry["persistence_session_id"], string | null>>,

  // 4. ServerInfoStatusPayload["features"] exposes inventorySessionsSnapshot.
  Expect<NotAny<ServerInfoStatusFeatures>>,
  Expect<IsEqual<ServerInfoStatusFeatures["inventorySessionsSnapshot"], boolean | undefined>>,

  // 5. Unknown inventory messages are not accepted by the inbound union.
  Expect<IsEqual<Extract<SessionInboundMessage, { type: "inventory.unknown.request" }>, never>>,
];
