export {
  openClientSecureChannel,
  openDaemonSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
  SecureChannelRejectedError,
} from "./secure-channel.js";
export type {
  ClientSecureChannelOptions,
  DaemonSecureChannelOptions,
  SecureChannel,
  SecureChannelEvents,
  SecurityMode,
} from "./secure-channel.js";

export { createClientChannel, createDaemonChannel, EncryptedChannel } from "./encrypted-channel.js";
export type { Transport, TransportMessage, EncryptedChannelEvents } from "./encrypted-channel.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair, SharedKey } from "./crypto.js";
