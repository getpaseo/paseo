export { openClientSecureChannel, openDaemonSecureChannel } from "./secure-channel.js";
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
