/** Largest WebSocket message the daemon accepts. A bigger one closes the connection with 1009. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 100 * 1024 * 1024;

/** Largest encrypted frame the relay accepts. */
export const MAX_RELAY_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
