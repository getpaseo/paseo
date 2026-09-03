/** Maximum encoded payload accepted by the Paseo WebSocket transport. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

/** Delivery responses may use the full transport limit. */
export const MAX_DELIVERY_RESPONSE_BYTES = MAX_WEBSOCKET_MESSAGE_BYTES;
