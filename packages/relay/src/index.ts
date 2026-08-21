export type { ConnectionRole, RelaySessionAttachment } from "./types.js";

export {
  InvalidPeerKeyError,
  CANONICAL_LOW_ORDER_POINTS,
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

export {
  base64EncryptedWireByteLength,
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  maxBase64EncryptedPlaintextByteLength,
} from "./encrypted-channel.js";
export type { Transport, EncryptedChannelEvents } from "./encrypted-channel.js";
