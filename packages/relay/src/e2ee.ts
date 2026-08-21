export { createClientChannel, createDaemonChannel, EncryptedChannel } from "./encrypted-channel.js";
export type { Transport, TransportMessage, EncryptedChannelEvents } from "./encrypted-channel.js";

export {
  InvalidPeerKeyError,
  CANONICAL_LOW_ORDER_POINTS,
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair, SharedKey } from "./crypto.js";
